import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { GoogleAuth } from "google-auth-library";
import dotenv from "dotenv";

import { google } from "googleapis";

dotenv.config();

const router = Router();

const execAsync = promisify(exec);

const resolutionFormatIds: { [resolution: string]: string[] } = {
  "144p": ["603", "269"],
  "240p": ["229", "604"],
  "360p": ["18"],
  "480p": ["231", "606"],
  "720p": ["232", "609"],
  "1080p": ["270", "614"],
  "1440p": ["620"],
  "2160p": ["625"],
  "720p60": ["311"],
  "1080p60": ["312"],
  "1440p60": ["623"],
  "2160p60": ["628"],
};

const generateUniqueFilename = (base: string): string => {
  const timestamp = Date.now();
  const randomStr = crypto.randomBytes(6).toString("hex"); // Generates a random string
  return `${base}_${timestamp}_${randomStr}`;
};

/**
 * Get all available formats for a given YouTube video URL and return unique quality labels.
 * @param {string} videoUrl - The YouTube video URL.
 * @returns {Promise<string[]>} - A promise that resolves to an array of unique quality labels.
 */
async function getQualityLabels(videoUrl: string): Promise<string[]> {
  try {
    const { stdout: formatsStdout } = await execAsync(`yt-dlp -U`);
    const { stdout: formatsStdout } = await execAsync(`yt-dlp -F ${videoUrl}`);
    const formatLines = formatsStdout.split("\n").slice(4); // Skip the first few header lines

    // Get video metadata
    const { stdout: metadataStdout } = await execAsync(
      `yt-dlp --skip-download --get-title --get-thumbnail --get-duration ${videoUrl}`
    );
    const metadataLines = metadataStdout.split("\n");

    const Title = metadataLines[0];
    const ThumbnailURL = metadataLines[1];
    const Duration = metadataLines[2];

    const Metadata = { Title, ThumbnailURL, Duration };
    // Define a function to extract quality label

    const extractQuality = (info: string) => {
      const match = info.match(
        /\b(?:144|240|360|480|720|1080|1440|2160)p(?:60)?\b/
      );
      return match ? match[0] : null;
    };

    // Extract quality labels, filter out null values and WebM formats
    const qualities = formatLines
      .map((line: string) => {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 4) return null;
        const quality = extractQuality(line);
        const ext = columns[columns.length - 2];
        return ext !== "webm" ? quality : null;
      })
      .filter(
        (quality: any, index: any, self: string | any[]) =>
          quality && self.indexOf(quality) === index
      ); // Remove duplicates and null values

    // Determine if any 60fps formats are present
    //@ts-ignore
    const is60fpsVideo = qualities.some((quality) => quality.endsWith("60"));

    // Filter out lower frame rate versions if 60fps video is detected
    const filteredQualities = qualities.filter((quality) => {
      if (is60fpsVideo) {
        //@ts-ignore
        return quality.endsWith("60");
      } else {
        //@ts-ignore
        return !quality.endsWith("60");
      }
    });
    //@ts-ignore
    console.log(filteredQualities, Metadata);
    //@ts-ignore
    return { qualities: filteredQualities, Metadata: Metadata };
  } catch (error) {
    console.error("Error fetching video formats:", error);
    throw error;
  }
}

const upload = multer();

const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "";

const auth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_FILE,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
//@ts-ignore
const drive = google.drive({ version: "v3", auth });

async function uploadFileToDrive(
  filePath: string
): Promise<string | undefined> {
  const requestBody = {
    name: path.basename(filePath),
    fields: "id",
  };

  const media = {
    mimeType: "video/mp4", // Ensure correct MIME type for your video
    body: fs.createReadStream(filePath),
  };

  try {
    const response = await drive.files.create({
      requestBody,
      media,
    });
    console.log("File Id:", response.data.id);
    //@ts-ignore
    return response.data.id;
  } catch (err) {
    console.error("Error uploading file:", err);
    throw err;
  }
}

router.post("/formats", async (req, res) => {
  const { videoUrl } = req.body;
  try {
    const qualitiesAndMetadata = await getQualityLabels(videoUrl);
    console.log(qualitiesAndMetadata);
    res.json(qualitiesAndMetadata);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch formats." });
  }
});

// Route to download and merge video and audio streams
router.post("/download", async (req, res) => {
  const { videoUrl, resolution } = req.body;
  const formatIds = resolutionFormatIds[resolution];

  if (!formatIds) {
    return res.status(400).json({ error: "Invalid resolution." });
  }
  const uniqueFilename = generateUniqueFilename("downloaded_video");

  try {
    const outputFile = await downloadAndMerge(
      videoUrl,
      formatIds[0],
      uniqueFilename
    );
    //@ts-ignore
    const currentDirectory = __dirname;

    // Get the parent directory (one folder back)
    const parentDirectory = path.join(currentDirectory, "..");
    const filepath = path.join(parentDirectory, `${uniqueFilename}.mp4`);
    try {
      const fileId = await uploadFileToDrive(filepath);

      if (!fileId) {
        return res.status(500).send("Failed to upload file");
      }

      await drive.permissions.create({
        fileId: fileId,
        requestBody: {
          role: "reader",
          type: "anyone",
        },
      });

      const result = await drive.files.get({
        fileId: fileId,
        fields: "webViewLink",
      });
      console.log(result.data.webViewLink);

      // Delete the local file after successful upload
      fs.unlink(filepath, (err) => {
        if (err) {
          console.error(`Failed to delete local file: ${filepath}`, err);
        } else {
          console.log(`Successfully deleted local file: ${filepath}`);
        }
      });

      const previewUrl = result.data.webViewLink;
      const DownloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;

      res.json({
        message: "Download, merge, and upload completed.",
        previewUrl,
        DownloadUrl,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to upload." });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to download, merge, or upload." });
  }
});

async function downloadAndMerge(
  videoUrl: string,
  formatId: string[0],
  output: string
) {
  try {
    const command = `yt-dlp -f ${formatId}+140 --merge-output-format mp4 -o "${output}.mp4" ${videoUrl}`;
    const { stdout, stderr } = await execAsync(command);
    console.log("Output:", stdout);
  } catch (error) {
    console.error("Error downloading and merging:", error);
    throw error;
  }
}

// async function uploadFile() {
//   try {

//   } catch (error) {
//     // Handle any errors that occur during the upload process
//     console.error("Error:", error);
//   }
// }

function scheduleGCPDeletion() {
  setTimeout(async () => {
    try {
    } catch (err) {}
  });
}

export default router;
