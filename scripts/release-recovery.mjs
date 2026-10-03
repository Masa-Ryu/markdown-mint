import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha256Pattern = /^[0-9a-f]{64}$/i;
const releaseLookupQuery = `query ReleaseForRecovery($owner: String!, $name: String!, $tag: String!) {
  repository(owner: $owner, name: $name) {
    release(tagName: $tag) {
      databaseId
      isDraft
    }
  }
}`;

/**
 * Find a release by tag, including drafts whose tag is still pending.
 * GitHub's REST tag lookup returns published releases only, so draft lookup
 * uses the repository's GraphQL release field and then fetches by database id.
 *
 * @param {ReleaseLookupOptions} options
 * @returns {Promise<ReleaseRecoveryRelease | null>}
 */
export async function lookupReleaseByTag({
  repository,
  tag,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${String(repository)}`);
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GitHub token is required to inspect releases");
  }
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("Release tag is required");
  }

  const [owner, name] = repository.split("/");
  const byTagUrl = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const publishedResponse = await fetchImpl(byTagUrl, { headers });
  if (publishedResponse.status === 200) return publishedResponse.json();
  if (publishedResponse.status !== 404) {
    throw new Error(
      `Published GitHub Release lookup failed (HTTP ${publishedResponse.status})`,
    );
  }

  const graphqlResponse = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: releaseLookupQuery,
      variables: { owner, name, tag },
    }),
  });
  if (graphqlResponse.status !== 200) {
    throw new Error(
      `Draft GitHub Release lookup failed (HTTP ${graphqlResponse.status})`,
    );
  }
  const graphqlBody = await graphqlResponse.json();
  if (graphqlBody.errors?.length) {
    throw new Error("Draft GitHub Release lookup returned GraphQL errors");
  }
  const draftReference = graphqlBody.data?.repository?.release;
  if (draftReference === null || draftReference === undefined) return null;
  if (draftReference.isDraft !== true) {
    const racedPublishedResponse = await fetchImpl(byTagUrl, { headers });
    if (racedPublishedResponse.status === 200) {
      return racedPublishedResponse.json();
    }
    throw new Error(
      "GitHub Release changed from draft while resolving its tag; retry recovery",
    );
  }
  if (
    !Number.isSafeInteger(draftReference.databaseId) ||
    draftReference.databaseId <= 0
  ) {
    throw new Error("Draft GitHub Release lookup returned an invalid id");
  }

  const draftResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/${draftReference.databaseId}`,
    { headers },
  );
  if (draftResponse.status !== 200) {
    throw new Error(
      `Draft GitHub Release fetch failed (HTTP ${draftResponse.status})`,
    );
  }
  const draft = await draftResponse.json();
  if (draft.draft === true) return draft;

  const racedPublishedResponse = await fetchImpl(byTagUrl, { headers });
  if (racedPublishedResponse.status === 200) {
    return racedPublishedResponse.json();
  }
  throw new Error(
    "GitHub Release changed from draft while resolving its tag; retry recovery",
  );
}

/**
 * Resolve the current release state through an injectable GitHub API client
 * and apply the pure recovery planner.
 *
 * @param {Omit<ReleaseRecoveryState, "release">} state
 * @param {ReleaseLookupOptions} options
 * @returns {Promise<{ plan: ReleaseRecoveryPlan; release: ReleaseRecoveryRelease | null }>}
 */
export async function planCurrentRelease(state, options) {
  const release = await lookupReleaseByTag({
    ...options,
    tag: state.tag,
  });
  return {
    plan: planReleaseRecovery({ ...state, release }),
    release,
  };
}

/**
 * Decide the next safe action for the GitHub Release publisher.
 * The caller supplies the resolved tag target and, when an asset exists, its
 * downloaded SHA-256. This function performs no GitHub or filesystem I/O.
 *
 * @param {ReleaseRecoveryState} state
 * @returns {ReleaseRecoveryPlan}
 */
export function planReleaseRecovery(state) {
  const {
    version,
    tag,
    targetCommitSha,
    tagTargetCommitSha,
    release,
    assetName,
    expectedSha256,
    actualAssetSha256,
    releaseNotes,
  } = state;

  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid release version: ${String(version)}`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match version ${version}`);
  }
  if (typeof targetCommitSha !== "string" || targetCommitSha.length === 0) {
    throw new Error("The target release commit is missing");
  }
  if (tagTargetCommitSha !== null && typeof tagTargetCommitSha !== "string") {
    throw new Error("The existing Git tag target is invalid");
  }
  if (
    typeof assetName !== "string" ||
    assetName !== `markdown-mint-${version}.vsix`
  ) {
    throw new Error(`Unexpected release asset name: ${String(assetName)}`);
  }
  if (typeof releaseNotes !== "string") {
    throw new Error("Release notes must be a string");
  }
  if (
    typeof expectedSha256 !== "string" ||
    !sha256Pattern.test(expectedSha256)
  ) {
    throw new Error("The expected VSIX SHA-256 is invalid");
  }
  if (tagTargetCommitSha !== null && tagTargetCommitSha !== targetCommitSha) {
    throw new Error(
      `Git tag ${tag} points to ${tagTargetCommitSha}, not ${targetCommitSha}`,
    );
  }

  if (release === null) {
    if (actualAssetSha256 !== null) {
      throw new Error("An asset checksum was supplied without a release");
    }
    return {
      action: "create_release",
      verifyTag: tagTargetCommitSha !== null,
    };
  }

  if (typeof release !== "object" || Array.isArray(release)) {
    throw new Error("The existing GitHub Release state is invalid");
  }
  if (release.tag_name !== tag) {
    throw new Error(`Existing GitHub Release tag does not match ${tag}`);
  }
  if (release.draft && release.target_commitish !== targetCommitSha) {
    throw new Error(
      `Draft GitHub Release ${tag} targets ${String(release.target_commitish)}, not ${targetCommitSha}`,
    );
  }
  if (!release.draft && tagTargetCommitSha === null) {
    throw new Error(`Published GitHub Release ${tag} has no Git tag`);
  }
  if (release.name !== `Markdown Mint ${tag}`) {
    throw new Error(`Existing GitHub Release ${tag} has an unexpected title`);
  }
  if ((release.body ?? "") !== releaseNotes) {
    throw new Error(`Existing GitHub Release ${tag} has unexpected notes`);
  }
  if (typeof release.draft !== "boolean") {
    throw new Error(`Existing GitHub Release ${tag} has no draft state`);
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error(`Existing GitHub Release ${tag} has an invalid id`);
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`Existing GitHub Release ${tag} has invalid assets`);
  }

  const expectedAssets = release.assets.filter(
    (asset) => asset?.name === assetName,
  );
  if (expectedAssets.length > 1) {
    throw new Error(`GitHub Release ${tag} has duplicate ${assetName} assets`);
  }
  if (expectedAssets.length === 0) {
    if (actualAssetSha256 !== null) {
      throw new Error("An asset checksum was supplied for a missing asset");
    }
    if (!release.draft) {
      throw new Error(
        `Published GitHub Release ${tag} is missing ${assetName}`,
      );
    }
    return { action: "upload_asset", releaseId: release.id };
  }

  const expectedAsset = expectedAssets[0];
  if (expectedAsset.state === "starter") {
    if (
      release.draft &&
      expectedAsset.size === 0 &&
      Number.isSafeInteger(expectedAsset.id) &&
      expectedAsset.id > 0 &&
      actualAssetSha256 === null
    ) {
      return {
        action: "delete_starter_asset",
        releaseId: release.id,
        assetId: expectedAsset.id,
      };
    }
    throw new Error(
      `GitHub Release ${tag} has a starter asset that is not an empty draft upload; inspect this release manually before retrying`,
    );
  }
  if (expectedAsset.state !== "uploaded") {
    throw new Error(
      `GitHub Release ${tag} has an unsupported asset state: ${String(expectedAsset.state)}`,
    );
  }

  if (actualAssetSha256 === null) {
    return { action: "verify_asset", releaseId: release.id };
  }
  if (
    typeof actualAssetSha256 !== "string" ||
    !sha256Pattern.test(actualAssetSha256)
  ) {
    throw new Error(`The ${assetName} SHA-256 is invalid`);
  }
  if (actualAssetSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `The ${assetName} SHA-256 does not match the validated VSIX`,
    );
  }

  return release.draft
    ? { action: "publish_release", releaseId: release.id }
    : { action: "already_published", releaseId: release.id };
}

async function main() {
  const command = process.argv[2];
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const state = JSON.parse(input);
  const result =
    command === "lookup-release"
      ? await lookupReleaseByTag({
          repository: state.repository,
          tag: state.tag,
          token: process.env.GH_TOKEN,
        })
      : command === "plan-current"
        ? await planCurrentRelease(state, {
            repository: process.env.GITHUB_REPOSITORY,
            token: process.env.GH_TOKEN,
          })
        : { plan: planReleaseRecovery(state), release: state.release };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
