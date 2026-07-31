/**
 * Remote worker factory: dispatches runs to conduit-worker processes connected
 * to the server's secure WebSocket control plane (/ws/worker). Selected with
 * CONDUIT_WORKER_FACTORY=remote (requires CONDUIT_WORKER_TOKEN set so workers
 * can authenticate).
 *
 * All lifecycle traffic — assignment, events, exit, cancel, lease-loss — flows
 * through the WorkerControlPlane, so this factory stays thin: the control
 * plane is the source of truth for remote run state.
 */
import type { RunSpec, WorkerEventSink, WorkerFactory, WorkerHandle } from '../../shared/worker'
import type { WorkerControlPlane } from '../workerControl'

export class RemoteWorkerFactory implements WorkerFactory {
  readonly kind = 'remote'

  constructor(private controlPlane: WorkerControlPlane) {}

  startRun(spec: RunSpec, sink: WorkerEventSink): Promise<WorkerHandle> {
    return this.controlPlane.assign(spec, sink)
  }

  async shutdown(): Promise<void> {
    // The control plane is owned by the server process (it also serves EKS/
    // Fargate callbacks later) — its lifecycle is managed there, not here.
  }
}
