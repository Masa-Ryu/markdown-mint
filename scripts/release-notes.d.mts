export declare function isValidSemVer(version: unknown): version is string;

export declare function extractReleaseNotes(
  packageVersion: string,
  changelog: string,
): string;

export declare function readCurrentReleaseNotes(root?: string): Promise<{
  version: string;
  releaseNotes: string;
}>;
