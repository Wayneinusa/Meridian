import { generateImages, generateVideo } from "../providers/media";
import { findModel } from "../providers/registry";
import type { Tool } from "./types";

const generateImage: Tool = {
  group: "media",
  title: "Generate image",
  spec: {
    name: "generate_image",
    description:
      "Generate one or more images from a text prompt with the image model the user configured. " +
      "Write a detailed, self-contained prompt (subject, style, composition, lighting). The images are shown to the user directly.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image" },
        shape: { type: "string", enum: ["square", "landscape", "portrait"], description: "Default square" },
        count: { type: "integer", description: "How many images, 1-4. Default 1." },
      },
      required: ["prompt"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Generate image: ${String(i.prompt).slice(0, 80)}`,
  async run(input, ctx) {
    const found = findModel(ctx.settings, ctx.settings.imageModel);
    if (!found) {
      return { isError: true, text: "No image model is configured. Tell the user to choose one in Settings → Models → Image generation." };
    }
    const apiKey = await ctx.getKey(found.provider.id);
    const images = await generateImages({
      provider: found.provider,
      apiKey,
      model: found.model,
      prompt: String(input.prompt),
      shape: input.shape as string | undefined,
      count: typeof input.count === "number" ? input.count : 1,
      signal: ctx.signal,
    });
    const refs = [];
    for (let i = 0; i < images.length; i++) {
      const ext = images[i].mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      refs.push(await ctx.saveBlob(images[i].bytes, images[i].mime, `image-${Date.now().toString(36)}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`));
    }
    return {
      text: `Generated ${refs.length} image(s) with ${found.model.name}. They are displayed to the user under this message.`,
      artifacts: refs,
    };
  },
};

const generateVideoTool: Tool = {
  group: "media",
  title: "Generate video",
  spec: {
    name: "generate_video",
    description:
      "Generate a short video clip from a text prompt with the video model the user configured. This takes several minutes and costs noticeably more than text; " +
      "only call it when the user asked for a video. Describe the scene, motion, camera and style in the prompt.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the clip" },
        shape: { type: "string", enum: ["landscape", "portrait"], description: "Default landscape" },
        seconds: { type: "integer", description: "Clip length in seconds, if the model allows choosing (typically 4-12)" },
      },
      required: ["prompt"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Generate video: ${String(i.prompt).slice(0, 80)}`,
  async run(input, ctx) {
    const found = findModel(ctx.settings, ctx.settings.videoModel);
    if (!found) {
      return { isError: true, text: "No video model is configured. Tell the user to choose one in Settings → Models → Video generation." };
    }
    const apiKey = await ctx.getKey(found.provider.id);
    ctx.progress("starting");
    const video = await generateVideo({
      provider: found.provider,
      apiKey,
      model: found.model,
      prompt: String(input.prompt),
      shape: input.shape as string | undefined,
      seconds: typeof input.seconds === "number" ? input.seconds : undefined,
      signal: ctx.signal,
      onProgress: ctx.progress,
    });
    const ext = video.mime.includes("webm") ? "webm" : "mp4";
    const ref = await ctx.saveBlob(video.bytes, video.mime.startsWith("video/") ? video.mime : "video/mp4", `video-${Date.now().toString(36)}.${ext}`);
    return { text: `Generated a video with ${found.model.name}. It is displayed to the user under this message.`, artifacts: [ref] };
  },
};

export const mediaTools: Tool[] = [generateImage, generateVideoTool];
