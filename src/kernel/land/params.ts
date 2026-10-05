// LandWorkflow params (`land-<repoUlid>-<batchUlid>`). Ids only: the workflow
// reads the batch from RepoDO, and no token ever travels in params (K11).

export type LandWorkflowParams = {
	readonly repoId: string;
	readonly batchId: string;
};
