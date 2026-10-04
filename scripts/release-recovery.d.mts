export interface ReleaseRecoveryAsset {
  id: number;
  name: string;
  state: string;
  size: number;
}

export interface ReleaseRecoveryRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string | null;
  target_commitish: string;
  draft: boolean;
  assets: ReleaseRecoveryAsset[];
}

export interface ReleaseLookupResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface ReleaseLookupOptions {
  repository: string;
  tag: string;
  token: string;
  fetchImpl?: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<ReleaseLookupResponse>;
}

export interface ReleaseRecoveryState {
  version: string;
  tag: string;
  targetCommitSha: string;
  tagTargetCommitSha: string | null;
  release: ReleaseRecoveryRelease | null;
  artifacts: Array<{
    target: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-arm64" | "win32-x64";
    assetName: string;
    expectedSha256: string;
    actualAssetSha256: string | null;
  }>;
  releaseNotes: string;
}

export type ReleaseRecoveryPlan =
  | { action: "create_release"; verifyTag: boolean }
  | { action: "upload_asset"; releaseId: number; assetName: string }
  | { action: "delete_starter_asset"; releaseId: number; assetId: number; assetName: string }
  | { action: "verify_asset"; releaseId: number; assetName: string }
  | { action: "publish_release"; releaseId: number }
  | { action: "already_published"; releaseId: number };

export declare function planReleaseRecovery(
  state: ReleaseRecoveryState,
): ReleaseRecoveryPlan;

export declare function lookupReleaseByTag(
  options: ReleaseLookupOptions,
): Promise<ReleaseRecoveryRelease | null>;

export declare function planCurrentRelease(
  state: Omit<ReleaseRecoveryState, "release">,
  options: ReleaseLookupOptions,
): Promise<{
  plan: ReleaseRecoveryPlan;
  release: ReleaseRecoveryRelease | null;
}>;
