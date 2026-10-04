import { describe, expect, it } from "vitest";
import {
  lookupReleaseByTag,
  planCurrentRelease,
  planReleaseRecovery,
  type ReleaseLookupOptions,
  type ReleaseLookupResponse,
  type ReleaseRecoveryRelease,
  type ReleaseRecoveryState,
} from "../../scripts/release-recovery.mjs";

const version = "0.9.0";
const tag = `v${version}`;
const targetCommitSha = "a".repeat(40);
const expectedSha256 = "b".repeat(64);
const differentSha256 = "c".repeat(64);
const releaseNotes = "- Release note.";
function artifacts(actual: string | null = null) {
  return [
    {
      assetName: `markdown-mint-${version}.vsix`,
      expectedSha256,
      actualAssetSha256: actual,
    },
  ];
}

function uploadedAssets() {
  return [
    {
      id: 84,
      name: `markdown-mint-${version}.vsix`,
      state: "uploaded",
      size: 1024,
    },
  ];
}

function state(
  overrides: Partial<ReleaseRecoveryState> = {},
): ReleaseRecoveryState {
  return {
    version,
    tag,
    targetCommitSha,
    tagTargetCommitSha: null,
    release: null,
    artifacts: artifacts(),
    releaseNotes,
    ...overrides,
  };
}

function existingRelease({
  draft,
  assets = [],
  ...overrides
}: Partial<ReleaseRecoveryRelease> &
  Pick<ReleaseRecoveryRelease, "draft">): ReleaseRecoveryRelease {
  return {
    id: 42,
    tag_name: tag,
    name: `Markdown Mint ${tag}`,
    body: releaseNotes,
    target_commitish: targetCommitSha,
    draft,
    assets,
    ...overrides,
  };
}

function response(status: number, body: unknown): ReleaseLookupResponse {
  return { status, json: async () => body };
}

type FetchMock = NonNullable<ReleaseLookupOptions["fetchImpl"]>;

describe("GitHub Release recovery planning", () => {
  it("creates a release and tag when neither exists", () => {
    expect(planReleaseRecovery(state())).toEqual({
      action: "create_release",
      verifyTag: false,
    });
  });

  it("creates a release against an existing tag at the expected commit", () => {
    expect(
      planReleaseRecovery(state({ tagTargetCommitSha: targetCommitSha })),
    ).toEqual({ action: "create_release", verifyTag: true });
  });

  it("rejects a tag at a different commit and incomplete universal manifests", () => {
    expect(() =>
      planReleaseRecovery(state({ tagTargetCommitSha: "d".repeat(40) })),
    ).toThrow("not");
    expect(() =>
      planReleaseRecovery(state({ artifacts: artifacts().slice(1) })),
    ).toThrow("one universal VSIX");
  });

  it("uploads the universal VSIX to a draft", () => {
    expect(
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({ draft: true }),
        }),
      ),
    ).toEqual({
      action: "upload_asset",
      releaseId: 42,
      assetName: `markdown-mint-${version}.vsix`,
    });
  });

  it("preserves release-note bytes, including the final newline, during recovery", () => {
    const notesWithFinalNewline = `${releaseNotes}\n`;
    const plan = planReleaseRecovery(
      state({
        releaseNotes: notesWithFinalNewline,
        release: existingRelease({
          draft: true,
          body: notesWithFinalNewline,
        }),
      }),
    );
    expect(plan.action).toBe("upload_asset");
  });

  it("requests the asset checksum and publishes only after it matches", () => {
    const assets = uploadedAssets();
    const draft = existingRelease({ draft: true, assets });
    expect(
      planReleaseRecovery(
        state({
          release: draft,
          artifacts: artifacts(),
        }),
      ),
    ).toEqual({
      action: "verify_asset",
      releaseId: 42,
      assetName: `markdown-mint-${version}.vsix`,
    });

    expect(
      planReleaseRecovery(
        state({ release: draft, artifacts: artifacts(expectedSha256) }),
      ),
    ).toEqual({ action: "publish_release", releaseId: 42 });
  });

  it("rejects a mismatched VSIX checksum and unexpected target-specific artifact", () => {
    const assets = uploadedAssets();
    expect(() =>
      planReleaseRecovery(
        state({
          release: existingRelease({ draft: true, assets }),
          artifacts: artifacts(differentSha256),
        }),
      ),
    ).toThrow("does not match");
    expect(() =>
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: [
              ...assets,
              {
                id: 99,
                name: `markdown-mint-${version}-legacy.vsix`,
                state: "uploaded",
                size: 1,
              },
            ],
          }),
        }),
      ),
    ).toThrow("unexpected VSIX asset");
  });

  it("rejects a published release missing its universal package", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: false,
            assets: [],
          }),
          artifacts: artifacts(),
        }),
      ),
    ).toThrow("missing");
  });

  it("deletes only an empty starter upload from a draft", () => {
    expect(
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: [
              {
                id: 99,
                name: artifacts()[0]!.assetName,
                state: "starter",
                size: 0,
              },
            ],
          }),
        }),
      ),
    ).toEqual({
      action: "delete_starter_asset",
      releaseId: 42,
      assetId: 99,
      assetName: artifacts()[0]!.assetName,
    });
    expect(() =>
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: [
              {
                id: 99,
                name: artifacts()[0]!.assetName,
                state: "starter",
                size: 2,
              },
            ],
          }),
        }),
      ),
    ).toThrow("not an empty draft upload");
  });

  it("rejects releases with mismatched notes and accepts a fully verified publication", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: uploadedAssets(),
            body: "Different notes",
          }),
        }),
      ),
    ).toThrow("unexpected notes");
    expect(
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({ draft: false, assets: uploadedAssets() }),
          artifacts: artifacts(expectedSha256),
        }),
      ),
    ).toEqual({ action: "already_published", releaseId: 42 });
  });
});

describe("GitHub Release API lookup", () => {
  const repository = "Masa-Ryu/markdown-mint";
  const restByTag = `https://api.github.com/repos/${repository}/releases/tags/${tag}`;
  const restById = `https://api.github.com/repos/${repository}/releases/42`;
  const graphql = "https://api.github.com/graphql";
  const options = { repository, tag, token: "test-token" };

  it("returns a published release from REST without querying draft state", async () => {
    const published = existingRelease({
      draft: false,
      assets: uploadedAssets(),
    });
    const calls: string[] = [];
    const fetchImpl: FetchMock = async (url) => {
      calls.push(url);
      return response(200, published);
    };
    await expect(
      lookupReleaseByTag({ ...options, fetchImpl }),
    ).resolves.toEqual(published);
    expect(calls).toEqual([restByTag]);
  });

  it("plans first publication and resumes an interrupted draft before verifying the package", async () => {
    let release: ReleaseRecoveryRelease | null = null;
    const fetchImpl: FetchMock = async (url, init) => {
      if (url === restByTag)
        return release && !release.draft
          ? response(200, release)
          : response(404, { message: "Not Found" });
      if (url === graphql) {
        const payload = JSON.parse(init?.body ?? "{}") as {
          variables?: { tag?: string };
        };
        expect(payload.variables?.tag).toBe(tag);
        return response(200, {
          data: {
            repository: {
              release: release?.draft
                ? { databaseId: release.id, isDraft: true }
                : null,
            },
          },
        });
      }
      if (url === restById && release?.draft) return response(200, release);
      throw new Error(`Unexpected mocked request: ${url}`);
    };
    const recoveryOptions = { ...options, fetchImpl };
    const initial = await planCurrentRelease(state(), recoveryOptions);
    expect(initial.release).toBeNull();
    expect(initial.plan).toEqual({
      action: "create_release",
      verifyTag: false,
    });

    release = existingRelease({ draft: true });
    const retry = await planCurrentRelease(state(), recoveryOptions);
    expect(retry.plan).toEqual({
      action: "upload_asset",
      releaseId: 42,
      assetName: artifacts()[0]!.assetName,
    });

    release = existingRelease({ draft: true, assets: uploadedAssets() });
    const beforeChecksums = await planCurrentRelease(state(), recoveryOptions);
    expect(beforeChecksums.plan).toEqual({
      action: "verify_asset",
      releaseId: 42,
      assetName: artifacts()[0]!.assetName,
    });
    const verified = await planCurrentRelease(
      state({ artifacts: artifacts(expectedSha256) }),
      recoveryOptions,
    );
    expect(verified.plan).toEqual({ action: "publish_release", releaseId: 42 });

    release = existingRelease({ draft: false, assets: uploadedAssets() });
    const complete = await planCurrentRelease(
      state({
        tagTargetCommitSha: targetCommitSha,
        artifacts: artifacts(expectedSha256),
      }),
      recoveryOptions,
    );
    expect(complete.plan).toEqual({
      action: "already_published",
      releaseId: 42,
    });
  });
});
