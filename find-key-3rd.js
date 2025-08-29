// Import necessary Node.js modules.
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Dynamically import node-fetch, which is an ESM module.
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const API_URL = "https://100x-server-production.up.railway.app/submit/checksum";

/**
 * =============================================================================
 * MAIN LOGIC
 * This is the entry point. It reads the checksum file, creates workers,
 * and manages the overall process.
 * =============================================================================
 */
const main = async () => {
  // To run this script in the background and ensure it continues after SSH disconnection, use:
  // nohup node find-key-3rd.js &
  // You can view the output with: tail -f nohup.out

  // --- Configuration ---
  const reportPath = await askQuestion(
    "Enter the full path to the checksum report file (e.g., ./checksum_report.txt): "
  );
  const failedLogPath = path.join(path.dirname(reportPath), "failed.txt");
  const processedLogPath = path.join(path.dirname(reportPath), "processed.txt");
  const ansFilePath = path.join(path.dirname(reportPath), "ans.txt");
  const failedStream = fs.createWriteStream(failedLogPath, {
    flags: "a",
  });
  const processedStream = fs.createWriteStream(processedLogPath, {
    flags: "a",
  });

  console.log(`Reading checksums from: '${reportPath}'...`);
  console.log(`Failed checksums will be logged to: '${failedLogPath}'`);
  console.log(
    `Processed (mismatched key) checksums will be logged to: '${processedLogPath}'`
  );

  // --- File Reading and Parsing ---
  const processedChecksums = await readExistingChecksums(processedLogPath);
  const failedChecksums = await readExistingChecksums(failedLogPath);
  const existingChecksums = new Set([
    ...processedChecksums,
    ...failedChecksums,
  ]);

  const checksums = await parseChecksumFile(reportPath, existingChecksums);
  const totalChecksums = checksums.length;

  if (totalChecksums === 0) {
    console.log(
      "No new checksums found in the specified file. All checksums have been checked."
    );
    return;
  }

  console.log(`Found ${totalChecksums} checksums to process.`);
  console.log(`Starting search...`);

  let processedCount = 0;
  let matchFound = false;

  console.time("Total Execution Time");

  for (const checksum of checksums) {
    if (matchFound) break;

    const response1 = await submitChecksum(checksum);

    if (!response1) {
      // Log only on network/server error for the first request
      failedStream.write(`${checksum}\n`);
      processedCount++;
      updateProgress(processedCount, totalChecksums);
      continue;
    }

    const response2 = await submitChecksum(checksum);

    if (!response2) {
      // Log only on network/server error for the second request
      failedStream.write(`${checksum}\n`);
      processedCount++;
      updateProgress(processedCount, totalChecksums);
      continue;
    }

    // Check for a match.
    if (response1.key && response2.key && response1.key === response2.key) {
      matchFound = true;
      fs.writeFileSync(
        ansFilePath,
        `checksum: ${checksum}\nkey: ${response1.key}\n`
      );

      console.timeEnd("Total Execution Time");
      process.stdout.write("\n"); // New line after progress bar.
      console.log("🎉 Match Found! 🎉");
      console.log("------------------------------------");
      console.log(`Checksum: ${checksum}`);
      console.log(`Key: ${response1.key}`);
      console.log(`✅ Answer saved to ${ansFilePath}`);
      console.log("------------------------------------");
      break;
    } else {
      // Not a match, but not a network failure.
      processedStream.write(`${checksum}\n`);
      processedCount++;
      updateProgress(processedCount, totalChecksums);
    }
  }

  if (!matchFound) {
    console.timeEnd("Total Execution Time");
    process.stdout.write("\n");
    console.log("Search complete. No matching key was found.");
  }
  failedStream.end();
  processedStream.end();
  process.exit(0);
};

function updateProgress(processed, total) {
  const percentage = ((processed / total) * 100).toFixed(2);
  process.stdout.write(
    `\nProgress: ${processed}/${total} checksums checked (${percentage}%)`
  );
}

/**
 * Sends a single checksum to the server.
 * @param {string} checksum - The SHA-256 checksum to send.
 * @returns {Promise<object|null>} The JSON response from the server or null on error.
 */
const submitChecksum = async (checksum) => {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        checksum,
      }),
    });
    if (!response.ok) {
      // Log server errors but continue processing.
      console.error(
        `\nReceived non-OK status ${response.status} for checksum ${checksum}`
      );
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error(
      `\nEncountered a network error for checksum ${checksum}:`,
      error
    );
    return null;
  }
};

/**
 * Reads a file containing previously processed or failed checksums.
 * @param {string} filePath - The path to the checksums file.
 * @returns {Promise<Set<string>>} A promise that resolves with a set of checksums.
 */
function readExistingChecksums(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return resolve(new Set());
    }
    const checksums = new Set();
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      checksums.add(line.trim());
    });

    rl.on("close", () => resolve(checksums));
    rl.on("error", reject);
  });
}

/**
 * Reads the checksum report file line by line.
 * @param {string} filePath - The path to the checksum file.
 * @returns {Promise<string[]>} A promise that resolves with an array of checksums.
 */
function parseChecksumFile(filePath, existingChecksums = new Set()) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    const checksums = [];
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const parts = line.split(",");
      // Assumes format is "filepath,checksum" and takes the second part.
      if (parts.length === 2 && parts[1]) {
        const checksum = parts[1].trim();
        if (!existingChecksums.has(checksum)) {
          checksums.push(checksum);
        }
      }
    });

    rl.on("close", () => resolve(checksums));
    rl.on("error", reject);
  });
}

/**
 * Prompts the user for input in the console.
 */
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

main().catch((err) => {
  console.error("\nAn error occurred in the main process:", err);
});
