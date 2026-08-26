/**
 * In-process fake ECS for `npm run e2e:fargate`.
 *
 * Loaded by FargateWorkerFactory when CONDUIT_FARGATE_E2E_FAKE_ECS points here.
 * RunTask records the request, invents a local task ARN, and (unless a skip-
 * spawn sentinel is present) launches a detached supervisor that runs
 * `node out/worker/index.js` with the RunTask overrides plus task-definition
 * env (process mode, one-shot, token). The supervisor outlives an abrupt
 * server death, records worker exit codes / reconnect retry timestamps into
 * CONDUIT_FARGATE_E2E_STATE, and is what the replacement process hydrates.
 * StopTask / DescribeTasks track and kill the supervisor process group.
 * lastStatus becomes STOPPED only when the worker process exits (skip-spawn
 * tasks with no process are marked STOPPED immediately).
 *
 * A replacement server hydrates existing task PID/status from the state file
 * and must not spawn a duplicate or wipe a surviving worker.
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

function emptySnapshot() {
  return { seq: 0, runTasks: [], tasks: {} }
}

function readSnapshot() {
  const dest = statePath()
  if (!dest || !fs.existsSync(dest)) return emptySnapshot()
  try {
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'))
    return {
      seq: Number(parsed.seq) || 0,
      runTasks: Array.isArray(parsed.runTasks) ? parsed.runTasks : [],
      tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
    }
  } catch {
    return emptySnapshot()
  }
}

function writeSnapshot(snapshot) {
  const dest = statePath()
  if (!dest) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2))
  fs.renameSync(tmp, dest)
}

function seqFromArn(arn) {
  const m = /\/(\d+)$/.exec(arn)
  return m ? Number(m[1]) : 0
}

function publicTask(t) {
  const livePid = t.lastStatus === 'STOPPED' ? null : (t.workerPid || t.pid)
  return {
    lastStatus: t.lastStatus,
    pid: livePid,
    supervisorPid: t.supervisorPid ?? null,
    workerPid: t.workerPid ?? livePid,
    workerId: t.workerId,
    runId: t.runId,
    exitCode: t.exitCode ?? null,
    signal: t.signal ?? null,
    retryTimestamps: t.retryTimestamps ?? [],
  }
}

/** Kill the worker process group so spawned CLI children (stub claude) die too. */
function killProcessGroup(pid, signal) {
  if (!pid) return
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

function patchTaskOnDisk(arn, patch) {
  const snapshot = readSnapshot()
  snapshot.tasks[arn] = { ...(snapshot.tasks[arn] ?? {}), ...patch }
  writeSnapshot(snapshot)
  return snapshot.tasks[arn]
}

function runSupervisor(arn) {
  const child = spawn(process.execPath, [workerBin()], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  patchTaskOnDisk(arn, {
    lastStatus: 'RUNNING',
    pid: child.pid ?? null,
    workerPid: child.pid ?? null,
    supervisorPid: process.pid,
  })

  const noteRetry = (buf) => {
    const text = buf.toString()
    if (!/Disconnected|reconnecting/i.test(text)) return
    const snapshot = readSnapshot()
    const current = snapshot.tasks[arn] ?? {}
    const retryTimestamps = [...(current.retryTimestamps ?? []), Date.now()]
    patchTaskOnDisk(arn, { retryTimestamps })
  }
  child.stdout?.on('data', noteRetry)
  child.stderr?.on('data', noteRetry)
  child.on('exit', (code, signal) => {
    patchTaskOnDisk(arn, {
      lastStatus: 'STOPPED',
      pid: null,
      workerPid: null,
      exitCode: typeof code === 'number' ? code : 1,
      signal: signal ?? null,
    })
    process.exit(typeof code === 'number' ? code : 1)
  })
  const forward = (sig) => {
    if (child.pid) killProcessGroup(child.pid, sig)
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
}

if (require.main === module && process.argv[2] === '--supervise') {
  runSupervisor(process.argv[3])
} else {
  module.exports = { createFakeEcsClient, TASK_ARN_PREFIX, FAKE_ACCOUNT }
}

function createFakeEcsClient() {
  /** @type {Map<string, { lastStatus: string, pid: number | null, supervisorPid?: number | null, workerPid?: number | null, workerId: string, runId: string, exitCode?: number | null, signal?: string | null, retryTimestamps?: number[], child?: import('node:child_process').ChildProcess }>} */
  const tasks = new Map()
  /** @type {object[]} */
  const runTasks = []
  let seq = 0

  function persist() {
    const dest = statePath()
    if (!dest) return
    const disk = readSnapshot()
    const merged = {}
    for (const [arn, t] of tasks.entries()) {
      const d = disk.tasks[arn] ?? {}
      const retryTimestamps =
        (d.retryTimestamps?.length ?? 0) > (t.retryTimestamps?.length ?? 0)
          ? d.retryTimestamps
          : t.retryTimestamps
      if (d.exitCode != null && t.exitCode == null) t.exitCode = d.exitCode
      if (d.signal && !t.signal) t.signal = d.signal
      if (d.lastStatus === 'STOPPED') t.lastStatus = 'STOPPED'
      if (d.workerPid && !t.workerPid) t.workerPid = d.workerPid
      if (d.supervisorPid && !t.supervisorPid) t.supervisorPid = d.supervisorPid
      if (d.pid && !t.pid) t.pid = d.pid
      t.retryTimestamps = retryTimestamps ?? []
      merged[arn] = publicTask(t)
    }
    for (const [arn, d] of Object.entries(disk.tasks)) {
      if (!merged[arn]) merged[arn] = d
    }
    writeSnapshot({ seq, runTasks, tasks: merged })
  }

  function refreshTask(arn) {
    const task = tasks.get(arn)
    if (!task || task.lastStatus === 'STOPPED') return task
    const disk = readSnapshot().tasks[arn]
    if (disk) {
      if (Array.isArray(disk.retryTimestamps)) task.retryTimestamps = disk.retryTimestamps
      if (disk.exitCode != null) task.exitCode = disk.exitCode
      if (disk.signal) task.signal = disk.signal
      if (disk.supervisorPid) task.supervisorPid = disk.supervisorPid
      if (disk.workerPid) {
        task.workerPid = disk.workerPid
        if (task.lastStatus !== 'STOPPED') task.pid = disk.workerPid
      } else if (disk.pid && task.lastStatus !== 'STOPPED') {
        task.pid = disk.pid
      }
      if (disk.lastStatus === 'STOPPED') {
        task.lastStatus = 'STOPPED'
        task.pid = null
        task.child = undefined
        persist()
        return task
      }
    }
    const expectedPid = task.pid || task.supervisorPid || task.workerPid
    if (!expectedPid && !task.child) return task
    const live = pidAlive(task.pid) || pidAlive(task.supervisorPid) || pidAlive(task.workerPid)
    if (!live) {
      task.lastStatus = 'STOPPED'
      task.pid = null
      task.child = undefined
      persist()
    }
    return task
  }

  function watchPid(arn) {
    const timer = setInterval(() => {
      const task = tasks.get(arn)
      if (!task || task.lastStatus === 'STOPPED') {
        clearInterval(timer)
        return
      }
      refreshTask(arn)
    }, 200)
    timer.unref()
  }

  function markStopped(arn) {
    const task = tasks.get(arn)
    if (!task) return
    task.lastStatus = 'STOPPED'
    task.pid = null
    task.child = undefined
    persist()
  }

  function killChild(task) {
    const pid = task.supervisorPid || task.pid
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
      CONDUIT_FARGATE_E2E_STATE: statePath(),
      CONDUIT_FARGATE_E2E_WORKER_BIN: workerBin(),
      ...overrides,
    }
    delete env.CONDUIT_WORKER_FACTORY
    delete env.CONDUIT_FARGATE_E2E_FAKE_ECS
    delete env.CONDUIT_FARGATE_CLUSTER
    delete env.CONDUIT_FARGATE_TASK_DEFINITION
    delete env.CONDUIT_FARGATE_SUBNETS
    delete env.CONDUIT_FARGATE_WORKER_TOKEN
    delete env.DATABASE_URL

    const child = spawn(process.execPath, [__filename, '--supervise', arn], {
      env,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    const task = tasks.get(arn)
    if (task) {
      task.pid = child.pid ?? null
      task.supervisorPid = child.pid ?? null
      task.child = child
    }
    persist()
    watchPid(arn)

    child.on('exit', () => {
      refreshTask(arn)
      if (tasks.get(arn)?.lastStatus !== 'STOPPED') markStopped(arn)
    })
    return { workerId, spawnEnv: { CONDUIT_PROCESS_MODE: 'worker', CONDUIT_WORKER_ONE_SHOT: 'true' } }
  }

  function hydrate() {
    const snapshot = readSnapshot()
    seq = snapshot.seq || 0
    for (const rec of snapshot.runTasks) {
      runTasks.push(rec)
      seq = Math.max(seq, seqFromArn(rec.taskArn) || 0)
    }
    for (const [arn, t] of Object.entries(snapshot.tasks)) {
      seq = Math.max(seq, seqFromArn(arn) || 0)
      const expectedPid = t.pid || t.supervisorPid || t.workerPid
      const live = pidAlive(t.pid) || pidAlive(t.supervisorPid) || pidAlive(t.workerPid)
      const lastStatus = expectedPid && !live ? 'STOPPED' : t.lastStatus || (live ? 'RUNNING' : 'STOPPED')
      tasks.set(arn, {
        lastStatus,
        pid: live ? t.pid ?? t.supervisorPid ?? t.workerPid ?? null : expectedPid ? null : t.pid ?? null,
        supervisorPid: t.supervisorPid ?? null,
        workerPid: t.workerPid ?? null,
        workerId: t.workerId,
        runId: t.runId,
        exitCode: t.exitCode ?? null,
        signal: t.signal ?? null,
        retryTimestamps: t.retryTimestamps ?? [],
      })
      if (live) watchPid(arn)
    }
  }

  hydrate()

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
    refreshTask(arn)
    if (task.lastStatus === 'STOPPED') {
      return { task: { taskArn: arn, lastStatus: 'STOPPED', desiredStatus: 'STOPPED' } }
    }
    if (!task.pid && !task.child && !task.supervisorPid) {
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
        refreshTask(arn)
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
