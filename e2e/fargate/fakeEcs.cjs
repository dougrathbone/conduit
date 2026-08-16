/**
 * In-process fake ECS for `npm run e2e:fargate`.
 *
 * Loaded by FargateWorkerFactory when CONDUIT_FARGATE_E2E_FAKE_ECS points here.
 * RunTask records the request, invents a local task ARN, and (unless a skip-
 * spawn sentinel is present) launches `node out/worker/index.js` with the
 * RunTask overrides plus task-definition env (process mode, one-shot, token).
 * StopTask / DescribeTasks track and kill the worker process group.
 * lastStatus becomes STOPPED only when the worker process exits (skip-spawn
 * tasks with no process are marked STOPPED immediately).
 *
 * State is persisted to CONDUIT_FARGATE_E2E_STATE so the driver can assert
 * cleanup, unique ARNs, and that secrets never appear in RunTask overrides.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const FAKE_ACCOUNT = '000000000000'
const TASK_ARN_PREFIX = `arn:aws:ecs:local:${FAKE_ACCOUNT}:task/conduit-e2e`

function statePath() {
  return process.env.CONDUIT_FARGATE_E2E_STATE?.trim() || ''
}

function skipSpawnPath() {
  return process.env.CONDUIT_FARGATE_E2E_SKIP_SPAWN?.trim() || ''
}

function workerBin() {
  return (
    process.env.CONDUIT_FARGATE_E2E_WORKER_BIN?.trim() ||
    path.resolve(process.cwd(), 'out/worker/index.js')
  )
}

function consumeSkipSpawn() {
  const file = skipSpawnPath()
  if (!file || !fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}

function overrideEnv(input) {
  const list = input.overrides?.containerOverrides?.[0]?.environment ?? []
  const env = {}
  for (const entry of list) {
    if (entry?.name) env[entry.name] = entry.value ?? ''
  }
  return env
}

function createFakeEcsClient() {
  /** @type {Map<string, { lastStatus: string, pid: number | null, workerId: string, runId: string, child?: import('node:child_process').ChildProcess }>} */
  const tasks = new Map()
  /** @type {object[]} */
  const runTasks = []
  let seq = 0

  function persist() {
    const dest = statePath()
    if (!dest) return
    const snapshot = {
      runTasks,
      tasks: Object.fromEntries(
        [...tasks.entries()].map(([arn, t]) => [
          arn,
          {
            lastStatus: t.lastStatus,
            pid: t.pid,
            workerId: t.workerId,
            runId: t.runId,
          },
        ])
      ),
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, JSON.stringify(snapshot, null, 2))
  }

  function markStopped(arn) {
    const task = tasks.get(arn)
    if (!task) return
    task.lastStatus = 'STOPPED'
    task.pid = null
    task.child = undefined
    persist()
  }

  /** Kill the worker process group so spawned CLI children (stub claude) die too. */
  function killProcessGroup(pid, signal) {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        // already gone
      }
    }
  }

  function killChild(task) {
    const pid = task.pid
    if (!pid) return
    const child = task.child
    const alreadyDead = !child || child.exitCode !== null || child.signalCode !== null
    killProcessGroup(pid, alreadyDead ? 'SIGKILL' : 'SIGTERM')
    if (alreadyDead) return
    setTimeout(() => {
      if (task.lastStatus !== 'STOPPED') killProcessGroup(pid, 'SIGKILL')
    }, 2000).unref()
  }

  function spawnWorker(arn, input) {
    const overrides = overrideEnv(input)
    const workerId = overrides.CONDUIT_WORKER_ID || ''
    const env = {
      ...process.env,
      CONDUIT_PROCESS_MODE: 'worker',
      CONDUIT_WORKER_ONE_SHOT: 'true',
      CONDUIT_WORKER_TOKEN: process.env.CONDUIT_WORKER_TOKEN,
      ...overrides,
    }
    delete env.CONDUIT_WORKER_FACTORY
    delete env.CONDUIT_FARGATE_E2E_FAKE_ECS
    delete env.CONDUIT_FARGATE_CLUSTER
    delete env.CONDUIT_FARGATE_TASK_DEFINITION
    delete env.CONDUIT_FARGATE_SUBNETS
    delete env.CONDUIT_FARGATE_WORKER_TOKEN
    delete env.DATABASE_URL

    const child = spawn(process.execPath, [workerBin()], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const task = tasks.get(arn)
    if (task) {
      task.pid = child.pid ?? null
      task.child = child
    }
    persist()

    child.on('exit', () => markStopped(arn))
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    return { workerId, spawnEnv: { CONDUIT_PROCESS_MODE: 'worker', CONDUIT_WORKER_ONE_SHOT: 'true' } }
  }

  async function runTask(input) {
    seq += 1
    const taskArn = `${TASK_ARN_PREFIX}/${String(seq).padStart(8, '0')}`
    const overrides = overrideEnv(input)
    const workerId = overrides.CONDUIT_WORKER_ID || ''
    const runId = (input.tags ?? []).find((t) => t.key === 'conduit:run-id')?.value || ''
    const skip = consumeSkipSpawn()

    tasks.set(taskArn, {
      lastStatus: 'RUNNING',
      pid: null,
      workerId,
      runId,
    })

    let spawnEnv = null
    if (!skip) {
      spawnEnv = spawnWorker(taskArn, input).spawnEnv
    }

    runTasks.push({
      taskArn,
      cluster: input.cluster,
      overrideNames: Object.keys(overrides),
      overrideEnv: overrides,
      spawnEnv,
      skippedSpawn: skip,
      workerId,
      runId,
    })
    persist()
    return { tasks: [{ taskArn, lastStatus: 'PROVISIONING' }], failures: [] }
  }

  async function stopTask(input) {
    const arn = input.task
    const task = tasks.get(arn)
    if (!task) {
      return { task: { taskArn: arn, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' } }
    }
    if (task.lastStatus === 'STOPPED') {
      return { task: { taskArn: arn, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' } }
    }
    if (!task.pid && !task.child) {
      // skip-spawn: no process to wait for
      markStopped(arn)
      return { task: { taskArn: arn, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' } }
    }
    killChild(task)
    return { task: { taskArn: arn, lastStatus: 'DEACTIVATING', desiredStatus: 'STOPPED' } }
  }

  async function describeTasks(input) {
    const found = []
    for (const arn of input.tasks ?? []) {
      const task = tasks.get(arn)
      if (task) {
        found.push({
          taskArn: arn,
          lastStatus: task.lastStatus,
          desiredStatus: task.lastStatus === 'STOPPED' ? 'STOPPED' : 'RUNNING',
        })
      }
    }
    return { tasks: found, failures: [] }
  }

  persist()

  return {
    async send(command) {
      const name = command.constructor.name
      const input = command.input ?? {}
      if (name === 'RunTaskCommand') return runTask(input)
      if (name === 'StopTaskCommand') return stopTask(input)
      if (name === 'DescribeTasksCommand') return describeTasks(input)
      throw new Error(`fake ECS: unsupported command ${name}`)
    },
  }
}

module.exports = { createFakeEcsClient, TASK_ARN_PREFIX, FAKE_ACCOUNT }
