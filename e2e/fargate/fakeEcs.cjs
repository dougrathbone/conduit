/**
 * In-process fake ECS for `npm run e2e:fargate`.
 *
 * Loaded by FargateWorkerFactory when CONDUIT_FARGATE_E2E_FAKE_ECS points here.
 * RunTask records the request, invents a local task ARN, and (unless a skip-
 * spawn sentinel is present) launches a detached supervisor that runs
 * `node out/worker/index.js`. The supervisor outlives an abrupt server death.
 *
 * Cross-process writers (server persist + supervisor exit/retry patches) share
 * CONDUIT_FARGATE_E2E_STATE under a lockfile: re-read, merge, atomic rename.
 * Merge keeps max seq, union runTasks by ARN, STOPPED dominance, unioned
 * retryTimestamps, and non-null exit / PID metadata. STOPPED tasks retain
 * supervisorPid, workerPid, and pgid so cleanup can still kill leaked groups.
 *
 * lastStatus becomes STOPPED when the worker exits (skip-spawn tasks with no
 * process are marked STOPPED immediately on StopTask).
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const FAKE_ACCOUNT = '000000000000'
const TASK_ARN_PREFIX = `arn:aws:ecs:local:${FAKE_ACCOUNT}:task/conduit-e2e`
const LOCK_STALE_MS = 2000
const LOCK_RETRY_MS = 10

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

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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

function coerceSnapshot(parsed) {
  return {
    seq: Number(parsed?.seq) || 0,
    runTasks: Array.isArray(parsed?.runTasks) ? parsed.runTasks : [],
    tasks: parsed?.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {},
  }
}

function readSnapshot() {
  const dest = statePath()
  if (!dest || !fs.existsSync(dest)) return emptySnapshot()
  try {
    return coerceSnapshot(JSON.parse(fs.readFileSync(dest, 'utf8')))
  } catch {
    return emptySnapshot()
  }
}

function writeAtomic(snapshot) {
  const dest = statePath()
  if (!dest) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2))
  fs.renameSync(tmp, dest)
}

function seqFromArn(arn) {
  const m = /\/(\d+)$/.exec(arn)
  return m ? Number(m[1]) : 0
}

function firstNonNull(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return null
}

function unionTimestamps(a, b) {
  const nums = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
  return [...new Set(nums)].sort((x, y) => x - y)
}

function asPid(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Normalize a task record: supervisorPid / workerPid / pgid are distinct. */
function normalizeTask(t = {}) {
  const supervisorPid = asPid(t.supervisorPid)
  const workerPid = asPid(t.workerPid) || (!t.supervisorPid ? asPid(t.pid) : null)
  const pgid = asPid(t.pgid) || supervisorPid
  return {
    lastStatus: t.lastStatus === 'STOPPED' ? 'STOPPED' : t.lastStatus || 'RUNNING',
    supervisorPid,
    workerPid,
    pgid,
    workerId: t.workerId || '',
    runId: t.runId || '',
    exitCode: t.exitCode == null ? null : Number(t.exitCode),
    signal: t.signal ?? null,
    retryTimestamps: unionTimestamps(t.retryTimestamps, []),
  }
}

function mergeTask(disk = {}, incoming = {}) {
  const a = normalizeTask(disk)
  const b = normalizeTask(incoming)
  const stopped = a.lastStatus === 'STOPPED' || b.lastStatus === 'STOPPED'
  return {
    lastStatus: stopped ? 'STOPPED' : b.lastStatus || a.lastStatus || 'RUNNING',
    supervisorPid: firstNonNull(b.supervisorPid, a.supervisorPid),
    workerPid: firstNonNull(b.workerPid, a.workerPid),
    pgid: firstNonNull(b.pgid, a.pgid, b.supervisorPid, a.supervisorPid),
    workerId: b.workerId || a.workerId,
    runId: b.runId || a.runId,
    exitCode: firstNonNull(b.exitCode, a.exitCode),
    signal: firstNonNull(b.signal, a.signal),
    retryTimestamps: unionTimestamps(a.retryTimestamps, b.retryTimestamps),
  }
}

function mergeRunTasks(disk = [], incoming = []) {
  const map = new Map()
  for (const rec of [...disk, ...incoming]) {
    if (!rec || typeof rec !== 'object' || !rec.taskArn) continue
    const prev = map.get(rec.taskArn) ?? {}
    map.set(rec.taskArn, { ...prev, ...rec })
  }
  return [...map.values()]
}

function mergeSnapshots(diskInput, incomingInput) {
  const disk = coerceSnapshot(diskInput)
  const incoming = coerceSnapshot(incomingInput)
  const arns = new Set([...Object.keys(disk.tasks), ...Object.keys(incoming.tasks)])
  const tasks = {}
  for (const arn of arns) {
    tasks[arn] = mergeTask(disk.tasks[arn], incoming.tasks[arn])
  }
  let seq = Math.max(disk.seq, incoming.seq)
  for (const rec of [...disk.runTasks, ...incoming.runTasks]) {
    seq = Math.max(seq, seqFromArn(rec?.taskArn) || 0)
  }
  for (const arn of arns) seq = Math.max(seq, seqFromArn(arn) || 0)
  return {
    seq,
    runTasks: mergeRunTasks(disk.runTasks, incoming.runTasks),
    tasks,
  }
}

function lockPath() {
  const dest = statePath()
  return dest ? `${dest}.lock` : ''
}

function readLockPid(file) {
  try {
    const n = Number(String(fs.readFileSync(file, 'utf8')).trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function acquireLock() {
  const file = lockPath()
  if (!file) return
  const start = Date.now()
  const deadline = start + LOCK_STALE_MS
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeFileSync(fd, String(process.pid))
      fs.closeSync(fd)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const holder = readLockPid(file)
      const stale = Date.now() >= deadline
      if (!holder || !pidAlive(holder) || stale) {
        try {
          fs.unlinkSync(file)
        } catch {
          // raced with another steal
        }
        if (stale && Date.now() - start > LOCK_STALE_MS + 500) {
          sleepMs(LOCK_RETRY_MS)
        }
        continue
      }
      sleepMs(LOCK_RETRY_MS)
    }
  }
}

function releaseLock() {
  const file = lockPath()
  if (!file) return
  const holder = readLockPid(file)
  if (holder && holder !== process.pid && pidAlive(holder)) return
  try {
    fs.unlinkSync(file)
  } catch {
    // already gone
  }
}

function persistSnapshot(incoming) {
  const dest = statePath()
  if (!dest) return
  acquireLock()
  try {
    const disk = readSnapshot()
    const merged = mergeSnapshots(disk, incoming)
    writeAtomic(merged)
  } finally {
    releaseLock()
  }
}

function publicTask(t) {
  return normalizeTask(t)
}

function cleanupPidsForTask(task = {}) {
  const n = normalizeTask(task)
  return [...new Set([n.pgid, n.supervisorPid, n.workerPid].filter((pid) => Number.isInteger(pid) && pid > 0))]
}

function killProcessGroup(pid, signal = 'SIGKILL') {
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

function killRecordedTasks(file) {
  if (file) process.env.CONDUIT_FARGATE_E2E_STATE = file
  const snapshot = readSnapshot()
  for (const task of Object.values(snapshot.tasks ?? {})) {
    const n = normalizeTask(task)
    // Signal the group even when the leader is already dead — leaked
    // descendants keep the pgid. pidAlive(leader) is not required.
    if (n.pgid) killProcessGroup(n.pgid, 'SIGKILL')
    for (const pid of cleanupPidsForTask(task)) {
      killProcessGroup(pid, 'SIGKILL')
    }
  }
}

function patchTaskOnDisk(arn, patch) {
  persistSnapshot({
    seq: 0,
    runTasks: [],
    tasks: { [arn]: patch },
  })
}

function runSupervisor(arn) {
  const child = spawn(process.execPath, [workerBin()], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  patchTaskOnDisk(arn, {
    lastStatus: 'RUNNING',
    workerPid: child.pid ?? null,
    supervisorPid: process.pid,
    pgid: process.pid,
  })

  const noteRetry = (buf) => {
    const text = buf.toString()
    if (!/Disconnected|reconnecting/i.test(text)) return
    const current = readSnapshot().tasks[arn] ?? {}
    patchTaskOnDisk(arn, {
      retryTimestamps: unionTimestamps(current.retryTimestamps, [Date.now()]),
      supervisorPid: process.pid,
      workerPid: child.pid ?? current.workerPid,
      pgid: process.pid,
    })
  }
  child.stdout?.on('data', noteRetry)
  child.stderr?.on('data', noteRetry)
  child.on('exit', (code, signal) => {
    patchTaskOnDisk(arn, {
      lastStatus: 'STOPPED',
      exitCode: typeof code === 'number' ? code : 1,
      signal: signal ?? null,
      supervisorPid: process.pid,
      workerPid: child.pid ?? null,
      pgid: process.pid,
    })
    process.exit(typeof code === 'number' ? code : 1)
  })
  const forward = (sig) => {
    if (child.pid) killProcessGroup(child.pid, sig)
  }
  process.on('SIGTERM', () => forward('SIGTERM'))
  process.on('SIGINT', () => forward('SIGINT'))
}

function createFakeEcsClient() {
  /** @type {Map<string, ReturnType<typeof normalizeTask> & { child?: import('node:child_process').ChildProcess }>} */
  const tasks = new Map()
  /** @type {object[]} */
  const runTasks = []
  let seq = 0

  function persist() {
    persistSnapshot({
      seq,
      runTasks,
      tasks: Object.fromEntries([...tasks.entries()].map(([arn, t]) => [arn, publicTask(t)])),
    })
    const disk = readSnapshot()
    seq = Math.max(seq, disk.seq)
    for (const rec of disk.runTasks) {
      if (!runTasks.some((r) => r.taskArn === rec.taskArn)) runTasks.push(rec)
    }
    for (const [arn, d] of Object.entries(disk.tasks)) {
      const cur = tasks.get(arn)
      if (!cur) {
        tasks.set(arn, { ...normalizeTask(d) })
        continue
      }
      Object.assign(cur, mergeTask(cur, d))
    }
  }

  function refreshTask(arn) {
    const task = tasks.get(arn)
    if (!task) return task
    const disk = readSnapshot().tasks[arn]
    if (disk) Object.assign(task, mergeTask(task, disk))
    if (task.lastStatus === 'STOPPED') return task
    const expectedPid = task.supervisorPid || task.workerPid || task.pgid
    if (!expectedPid && !task.child) return task
    const live = pidAlive(task.supervisorPid) || pidAlive(task.workerPid) || pidAlive(task.pgid)
    if (!live) {
      task.lastStatus = 'STOPPED'
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
    persist()
  }

  function killChild(task) {
    const pid = task.pgid || task.supervisorPid || task.workerPid
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
      task.supervisorPid = child.pid ?? null
      task.pgid = child.pid ?? null
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
      const task = normalizeTask(t)
      const expectedPid = task.supervisorPid || task.workerPid || task.pgid
      const live = pidAlive(task.supervisorPid) || pidAlive(task.workerPid) || pidAlive(task.pgid)
      if (expectedPid && !live) task.lastStatus = 'STOPPED'
      tasks.set(arn, task)
      if (live) watchPid(arn)
    }
  }

  hydrate()

  async function runTask(input) {
    seq += 1
    const taskArn = `${TASK_ARN_PREFIX}/${String(seq).padStart(8, '0')}`
    const overrides = overrideEnv(input)
    const workerId = overrides.CONDUIT_WORKER_ID || ''
    const runId = (input.tags ?? []).find((tag) => tag.key === 'conduit:run-id')?.value || ''
    const skip = consumeSkipSpawn()

    tasks.set(taskArn, {
      lastStatus: 'RUNNING',
      supervisorPid: null,
      workerPid: null,
      pgid: null,
      workerId,
      runId,
      exitCode: null,
      signal: null,
      retryTimestamps: [],
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
    if (!task.supervisorPid && !task.workerPid && !task.child && !task.pgid) {
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

if (require.main === module && process.argv[2] === '--supervise') {
  runSupervisor(process.argv[3])
} else if (require.main === module && process.argv[2] === '--persist-patch') {
  persistSnapshot(JSON.parse(process.argv[3]))
} else {
  module.exports = {
    createFakeEcsClient,
    mergeSnapshots,
    persistSnapshot,
    cleanupPidsForTask,
    killRecordedTasks,
    TASK_ARN_PREFIX,
    FAKE_ACCOUNT,
  }
}
