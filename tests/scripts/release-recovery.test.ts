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

const version = "0.7.1";
const tag = `v${version}`;
const targetCommitSha = "a".repeat(40);
const expectedSha256 = "b".repeat(64);
const differentSha256 = "c".repeat(64);
const assetName = `markdown-mint-${version}.vsix`;
const releaseNotes = "- Release note.";

function state(
  overrides: Partial<ReleaseRecoveryState> = {},
): ReleaseRecoveryState {
  return {
    version,
    tag,
    targetCommitSha,
    tagTargetCommitSha: null,
    release: null,
    assetName,
    expectedSha256,
    actualAssetSha256: null,
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

function uploadedAsset() {
  return { id: 84, name: assetName, state: "uploaded", size: 1024 };
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

  it("rejects an existing tag at a different commit", () => {
    expect(() =>
      planReleaseRecovery(state({ tagTargetCommitSha: "d".repeat(40) })),
    ).toThrow("not");
  });

  it("uploads the expected artifact to a draft without that asset", () => {
    expect(
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({ draft: true }),
        }),
      ),
    ).toEqual({ action: "upload_asset", releaseId: 42 });
  });

  it("publishes a draft with an asset matching the validated SHA-256", () => {
    expect(
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: true,
            assets: [uploadedAsset()],
          }),
          actualAssetSha256: expectedSha256,
        }),
      ),
    ).toEqual({ action: "publish_release", releaseId: 42 });
  });

  it("rejects an asset whose SHA-256 conflicts with the validated VSIX", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: true,
            assets: [uploadedAsset()],
          }),
          actualAssetSha256: differentSha256,
        }),
      ),
    ).toThrow("does not match");
  });

  it("rejects a published release with a conflicting VSIX checksum", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: false,
            assets: [uploadedAsset()],
          }),
          actualAssetSha256: differentSha256,
        }),
      ),
    ).toThrow("does not match");
  });

  it("accepts a published release with the expected tag, notes, and asset", () => {
    expect(
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: false,
            assets: [uploadedAsset()],
          }),
          actualAssetSha256: expectedSha256,
        }),
      ),
    ).toEqual({ action: "already_published", releaseId: 42 });
  });

  it("rejects a published release with mismatched release notes", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: false,
            assets: [uploadedAsset()],
            body: "- Different release note.",
          }),
          actualAssetSha256: expectedSha256,
        }),
      ),
    ).toThrow("unexpected notes");
  });

  it("deletes only an empty starter upload from a draft", () => {
    expect(
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: [{ id: 99, name: assetName, state: "starter", size: 0 }],
          }),
        }),
      ),
    ).toEqual({
      action: "delete_starter_asset",
      releaseId: 42,
      assetId: 99,
    });
  });

  it("rejects a nonempty starter upload instead of deleting it", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          release: existingRelease({
            draft: true,
            assets: [{ id: 99, name: assetName, state: "starter", size: 2 }],
          }),
        }),
      ),
    ).toThrow("not an empty draft upload");
  });

  it("never deletes a starter asset from a published release", () => {
    expect(() =>
      planReleaseRecovery(
        state({
          tagTargetCommitSha: targetCommitSha,
          release: existingRelease({
            draft: false,
            assets: [{ id: 99, name: assetName, state: "starter", size: 0 }],
          }),
        }),
      ),
    ).toThrow("not an empty draft upload");
  });
});

describe("GitHub Release API lookup", () => {
  const repository = "Masa-Ryu/markdown-mint";
  const restByTag = `https://api.github.com/repos/${repository}/releases/tags/${tag}`;
  const restById = `https://api.github.com/repos/${repository}/releases/42`;
  const graphql = "https://api.github.com/graphql";
  const options = {
    repository,
    tag,
    token: "test-token",
  };

  it("returns a published release from REST without querying draft state", async () => {
    const published = existingRelease({
      draft: false,
      assets: [uploadedAsset()],
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

  it("plans first publication and resumes an interrupted draft through mocked APIs", async () => {
    let release: ReleaseRecoveryRelease | null = null;
    const calls: string[] = [];
    const fetchImpl: FetchMock = async (url, init) => {
      calls.push(url);
      if (url === restByTag) {
        return release && !release.draft
          ? response(200, release)
          : response(404, { message: "Not Found" });
      }
      if (url === graphql) {
        const payload = JSON.parse(init?.body ?? "{}") as {
          query?: string;
          variables?: { tag?: string };
        };
        expect(payload.query).toContain("release(tagName: $tag)");
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
    const initialState = state();
    const { release: initialRelease, plan: initialPlan } =
      await planCurrentRelease(initialState, recoveryOptions);
    expect(initialRelease).toBeNull();
    expect(initialPlan).toEqual({ action: "create_release", verifyTag: false });

    // Simulate gh release create returning after it made a draft but before
    // the workflow could finish uploading the expected VSIX.
    release = existingRelease({ draft: true });
    const retryState = state({ tagTargetCommitSha: null });
    const { release: recoveredDraft, plan: retryPlan } =
      await planCurrentRelease(retryState, recoveryOptions);
    expect(recoveredDraft).toEqual(release);
    expect(retryPlan).toEqual({ action: "upload_asset", releaseId: 42 });
    expect(calls).toContain(restById);

    release = existingRelease({ draft: true, assets: [uploadedAsset()] });
    const afterUpload = await planCurrentRelease(
      state({
        tagTargetCommitSha: null,
        actualAssetSha256: expectedSha256,
      }),
      recoveryOptions,
    );
    expect(afterUpload.plan).toEqual({
      action: "publish_release",
      releaseId: 42,
    });

    release = existingRelease({ draft: false, assets: [uploadedAsset()] });
    const complete = await planCurrentRelease(
      state({
        tagTargetCommitSha: targetCommitSha,
        actualAssetSha256: expectedSha256,
      }),
      recoveryOptions,
    );
    expect(complete.plan).toEqual({
      action: "already_published",
      releaseId: 42,
    });
  });
});
