/**
 * Worker factory registry — env-driven selection of the execution substrate,
 * mirroring the observability reporter registry (shared/observability.ts).
 *
 * `CONDUIT_WORKER_FACTORY` selects the factory:
 * - `local`   (default) — in-process spawn; identical to Conduit's original
 *             single-process behavior. Zero config, zero impact.
 * - `remote`  — dispatch RunSpecs to conduit-worker processes over the WSS
 *             control plane (/ws/worker). Requires CONDUIT_WORKER_TOKEN.
 * - `eks`     — one Kubernetes Job per run; the pod connects back over the
 *             control plane. See src/server/workers/eksWorker.ts for env.
 * - `fargate` — one ECS task per run; same control-plane flow. See
 *             src/server/workers/fargateWorker.ts for env.
 */
import type { WorkerFactory } from '../../shared/worker'
import { LocalWorkerFactory } from './localWorker'
import { RemoteWorkerFactory } from './remoteWorker'
import { EksWorkerFactory, resolveEksConfig } from './eksWorker'
import { FargateWorkerFactory, resolveFargateConfig } from './fargateWorker'
import { getWorkerControlPlane } from '../workerControl'

export const KNOWN_WORKER_FACTORIES = ['local', 'remote', 'eks', 'fargate'] as const
export type WorkerFactoryKind = (typeof KNOWN_WORKER_FACTORIES)[number]

export function resolveWorkerFactoryKind(env: NodeJS.ProcessEnv = process.env): WorkerFactoryKind {
  const raw = env.CONDUIT_WORKER_FACTORY?.trim().toLowerCase()
  if (!raw) return 'local'
  if ((KNOWN_WORKER_FACTORIES as readonly string[]).includes(raw)) return raw as WorkerFactoryKind
  console.warn(`[workers] Unknown CONDUIT_WORKER_FACTORY "${raw}" — falling back to "local"`)
  return 'local'
}

let activeFactory: WorkerFactory | null = null

/** The process-wide worker factory, created lazily from the environment. */
export function getWorkerFactory(): WorkerFactory {
  if (activeFactory) return activeFactory
  const kind = resolveWorkerFactoryKind()
  switch (kind) {
    case 'local':
      activeFactory = new LocalWorkerFactory()
      break
    case 'remote':
      activeFactory = new RemoteWorkerFactory(getWorkerControlPlane())
      break
    case 'eks':
      activeFactory = new EksWorkerFactory(getWorkerControlPlane(), resolveEksConfig())
      break
    case 'fargate':
      activeFactory = new FargateWorkerFactory(getWorkerControlPlane(), resolveFargateConfig())
      break
  }
  return activeFactory
}

/** Test hook: reset the cached factory so a new one is built from current env. */
export function resetWorkerFactoryForTests(): void {
  activeFactory = null
}
