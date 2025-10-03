// Import required modules
const fs = require("fs");
const path = require("path");
const { chunkText, isTextFile, pickFiles } = require("./util");

// Get environment variables
const GH_EVENT_PATH = process.env.GITHUB_EVENT_PATH;
const GH_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const LLM_PROVIDER = process.env.LLM_PROVIDER || "google";
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "2500", 10);
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.2");
const FILE_GLOBS = (process.env.FILE_GLOBS || "")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

// Main function
async function main() {
  try {
    const { Octokit } = await import("@octokit/rest");

    console.log("Starting AI PR review in main ...");

    if (!GH_EVENT_PATH || !GH_TOKEN || !GH_REPOSITORY) {
      throw new Error("Missing required GitHub env (GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_REPOSITORY).");
    }

    const event = JSON.parse(fs.readFileSync(GH_EVENT_PATH, "utf8"));
    const { number: pull_number } = event.pull_request || {};
    if (!pull_number) throw new Error("This workflow must run on pull_request events.");

    const [owner, repo] = GH_REPOSITORY.split("/");
    const octokit = new Octokit({ auth: GH_TOKEN });

    console.log("GH_EVENT_PATH: ", GH_EVENT_PATH);
    console.log("GH_REPOSITORY: ", GH_REPOSITORY);
    console.log("FILE_GLOBS: ", FILE_GLOBS);
    console.log("owner: ", owner);
    console.log("repo: ", repo);
    console.log("pull_number: ", pull_number);

    // Get PR metadata
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
    const headSha = pr.head.sha;
    console.log("headSha: ", headSha);

    // Get changed files (with patches)
    const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });

    // Select files to review (by type + glob)
    const selected = files.filter((f) => isTextFile(f.filename) && (!FILE_GLOBS.length || pickFiles([f.filename], FILE_GLOBS).length));

    // Build prompt input from patches (unified diff). Limit total size.
    const DIFF_LIMIT_CHARS = 120_000; // guardrail for token/cost
    let total = 0;
    const diffs = [];

    // Extract diffs for selected files
    for (const f of selected) {
      const diff = JSON.stringify(f);
      console.log(`Extracting diff for file ${f.filename} =====>`, diff);
      if (!f.patch) continue; // binary or too large
      const chunk = `FILE: ${f.filename}\nSTATUS: ${f.status} additions:${f.additions} deletions:${f.deletions}\nDIFF: \n${diff}`;
      if (total + chunk.length > DIFF_LIMIT_CHARS) continue;
      diffs.push(chunk);
      total += chunk.length;
    }

    if (!diffs.length) {
      console.error("❌ No textual diffs to review. Exiting.");
      return;
    }

    // Load rubric + system guardrails
    const rubric = fs.readFileSync(path.join(__dirname, "..", "prompts", "rubric.md"), "utf8");
    const system = fs.readFileSync(path.join(__dirname, "..", "prompts", "system.md"), "utf8");

    const input = [
      `PR #${pull_number}: ${pr.title}`,
      `Author: ${pr.user && pr.user.login}`,
      `Base: ${pr.base && pr.base.ref}  ->  Head: ${pr.head && pr.head.ref}`,
      pr.body ? `\nPR DESCRIPTION:\n${pr.body}\n` : "",
      `\nRUBRIC:\n${rubric}\n`,
      `\nDIFFS (unified):\n${chunkText(diffs.join("\n\n"), 100_000)}`,
    ].join("\n");

    // Call LLM to get AI response
    const { callLLM } = require("./llm");
    const review = await callLLM({
      provider: LLM_PROVIDER,
      model: MODEL,
      system,
      user: input,
      maxTokens: MAX_TOKENS,
      temperature: TEMPERATURE,
    });

    // Process AI response and post review
    await processAIResponseAndPostReview(octokit, owner, repo, pull_number, headSha, review, selected.length);
  } catch (error) {
    console.error("Error in main:", error);
    process.exit(1);
  }
}

// Main function to handle AI response and post GitHub review
async function processAIResponseAndPostReview(octokit, owner, repo, pull_number, headSha, aiResponse, selectedFilesCount) {
  try {
    // Parse the AI response
    const parsedComments = cleanAndParseAIResponse(aiResponse);

    // Convert to GitHub comment format
    const githubComments = convertToGitHubComments(parsedComments);
    console.log("githubComments comments length =====>", githubComments.comments.length);

    // Post single comprehensive review with comments and approval decision
    const reviewEvent = githubComments.isApproved ? "COMMENT" : "REQUEST_CHANGES";
    const reviewBody = githubComments.isApproved ? `PR is looking great! Approved the PR` : `PR needs some changes.`;

    const githubReview = {
      owner,
      repo,
      pull_number,
      event: reviewEvent,
      body: reviewBody,
    };

    if (githubComments.comments.length > 0) {
      githubReview.comments = githubComments.comments;
    } else {
      githubReview.body = githubComments.isApproved ? "There are no issues that are tied to any specific lines." : "AI found general issues not tied to specific lines.";
    }

    await octokit.pulls.createReview(githubReview);
    console.log(`✅ AI ${reviewEvent.toLowerCase().replace("_", " ")}d the PR.`);

    // Set commit status based on AI review result
    await setCommitStatus(octokit, owner, repo, pull_number, headSha, githubComments.isApproved);

    return {
      success: true,
      type: githubComments.isApproved ? "approved" : "changes_requested",
      commentCount: githubComments.comments.length,
    };
  } catch (parseError) {
    console.error("Failed to parse AI response:", parseError.message);
    console.log("Raw AI response:", aiResponse);

    return await postGeneralReview(octokit, owner, repo, pull_number, aiResponse, "JSON parsing failed");
  }
}

// Helper function to post general review as fallback
async function postGeneralReview(octokit, owner, repo, pull_number, aiResponse, reason) {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    event: "COMMENT",
    body: `AI Code Review:\n\n${aiResponse.trim().slice(0, 65000)}`,
  });

  console.log(`✅ AI review posted as general comment (fallback: ${reason}).`);
  return { success: true, type: "general", reason };
}

// Helper function to clean and parse AI response
function cleanAndParseAIResponse(aiResponse) {
  let cleanedResponse = aiResponse.trim();

  // Remove markdown code block formatting if present
  if (cleanedResponse.startsWith("```json")) {
    cleanedResponse = cleanedResponse.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleanedResponse.startsWith("```")) {
    cleanedResponse = cleanedResponse.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(cleanedResponse);

  // Validate the response structure
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid response format: expected an object");
  }

  if (!("review" in parsed) || !Array.isArray(parsed.review)) {
    throw new Error('Invalid response format: missing or invalid "review" array');
  }

  if (!("isApproved" in parsed) || typeof parsed.isApproved !== "boolean") {
    console.warn('Response missing "isApproved" boolean field');
    parsed.isApproved = false;
  }

  return parsed;
}

// Helper function to convert AI comments to GitHub format
function convertToGitHubComments(aiResponse) {
  if (!aiResponse || !Array.isArray(aiResponse.review)) {
    throw new Error("Invalid AI response format: missing review array");
  }

  const githubComments = [];
  const processedFiles = new Set();

  for (const fileObject of aiResponse.review) {
    if (!fileObject.fileName || !Array.isArray(fileObject.comments)) {
      console.error("Invalid file object structure:", fileObject);
      continue;
    }

    // Skip duplicate files
    if (processedFiles.has(fileObject.fileName)) {
      console.warn(`Skipping duplicate file: ${fileObject.fileName}`);
      continue;
    }
    processedFiles.add(fileObject.fileName);

    for (const comment of fileObject.comments) {
      if (comment.absolutePosition === undefined || comment.value === undefined) {
        console.error("Invalid comment object structure:", comment);
        continue;
      }

      const position = parseInt(comment.absolutePosition, 10);
      if (isNaN(position) || position < 1) {
        console.error("Invalid position value:", comment.absolutePosition);
        continue;
      }

      githubComments.push({
        path: fileObject.fileName,
        position: position,
        body: comment.value,
      });
    }
  }

  return {
    comments: githubComments,
    isApproved: aiResponse.isApproved === true,
  };
}

// Helper function to set commit status based on AI review result
async function setCommitStatus(octokit, owner, repo, pull_number, headSha, isApproved) {
  try {
    let count = 0;

    const status = isApproved ? "success" : "failure";
    const description = isApproved ? "AI Code Review: All checks passed" : "AI Code Review: Issues found - review required";

    const statusData = {
      owner,
      repo,
      sha: headSha,
      state: status,
      target_url: `https://github.com/${owner}/${repo}/pull/${pull_number}`,
      description: description,
      context: "AI Code Review",
    };

    await octokit.repos.createCommitStatus(statusData);
    console.log(`✅ Commit status set to ${status} for SHA ${headSha}`);
  } catch (error) {
    console.error("Error setting commit status:", error);
    // Don't fail the entire process if status setting fails
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
