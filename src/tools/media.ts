import { generateImages, generateVideo, pickDefaultMedia, type MediaInput } from "../providers/media";
import { allProviders, findModel } from "../providers/registry";
import type { BlobRef, MediaOptions, ModelRef, Settings } from "../types";
import type { Tool, ToolContext } from "./types";

/** The media model to use: the one chosen in Settings, else the best one available. */
export function mediaModelFor(settings: Settings, kind: "image" | "video"): ModelRef | undefined {
  const chosen = kind === "image" ? settings.imageModel : settings.videoModel;
  if (chosen && findModel(settings, chosen)) return chosen;
  return pickDefaultMedia(allProviders(settings), kind);
}

export function noMediaModelMessage(kind: "image" | "video"): string {
  return kind === "image"
    ? "No image backend is ready. Turn on Pollinations or AI Horde (free, no key) in Settings → Providers & keys, set up Cloudflare's free tier, or add a key for OpenAI, Google Gemini, xAI or OpenRouter."
    : "No video backend is ready. For free video, get a free key at enter.pollinations.ai and paste it in Settings → Providers & keys → Pollinations. Keys for OpenAI (Sora), Google Gemini (Veo), xAI (Grok Imagine), fal.ai or Runway work too.";
}

export interface CreateMediaArgs {
  kind: "image" | "video";
  prompt: string;
  options?: MediaOptions;
  inputs?: BlobRef[];
  model?: ModelRef;
}

/** Shared by the tools below and by chats whose selected model is itself an image or video model. */
export async function createMedia(
  args: CreateMediaArgs,
  ctx: Pick<ToolContext, "settings" | "getKey" | "loadBlob" | "saveBlob" | "signal" | "progress">,
): Promise<{ refs: BlobRef[]; modelName: string }> {
  const modelRef = args.model ?? mediaModelFor(ctx.settings, args.kind);
  const found = findModel(ctx.settings, modelRef);
  if (!found) throw new Error(noMediaModelMessage(args.kind));
  const apiKey = await ctx.getKey(found.provider.id);
  const inputs: MediaInput[] = [];
  for (const b of args.inputs ?? []) {
    if (!b.mime.startsWith("image/")) continue;
    const bytes = await ctx.loadBlob(b.blobId);
    if (bytes) inputs.push({ bytes, mime: b.mime, name: b.name });
  }
  const stamp = Date.now().toString(36);
  if (args.kind === "image") {
    ctx.progress(inputs.length ? "editing image" : "creating image");
    const images = await generateImages({ provider: found.provider, apiKey, model: found.model, prompt: args.prompt, options: args.options, inputs, signal: ctx.signal, onProgress: ctx.progress });
    const refs: BlobRef[] = [];
    for (let i = 0; i < images.length; i++) {
      const ext = images[i].mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      refs.push(await ctx.saveBlob(images[i].bytes, images[i].mime, `image-${stamp}${images.length > 1 ? `-${i + 1}` : ""}.${ext}`));
    }
    return { refs, modelName: found.model.name };
  }
  ctx.progress(inputs.length ? "animating image" : "starting video");
  const video = await generateVideo({ provider: found.provider, apiKey, model: found.model, prompt: args.prompt, options: args.options, inputs: inputs.slice(0, 1), signal: ctx.signal, onProgress: (n) => ctx.progress(`video ${n}`) });
  const ext = video.mime.includes("webm") ? "webm" : video.mime.includes("quicktime") ? "mov" : "mp4";
  const saved = await ctx.saveBlob(video.bytes, video.mime.startsWith("video/") ? video.mime : "video/mp4", `video-${stamp}.${ext}`);
  return { refs: [saved], modelName: found.model.name };
}

function inputsFromNames(names: unknown, ctx: ToolContext): BlobRef[] {
  if (!Array.isArray(names)) return [];
  const files = ctx.files();
  const out: BlobRef[] = [];
  for (const n of names) {
    const hit = [...files].reverse().find((f) => f.name === n) ?? [...files].reverse().find((f) => f.name.toLowerCase() === String(n).toLowerCase());
    if (hit) out.push(hit);
  }
  return out;
}

const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];

const generateImage: Tool = {
  group: "media",
  title: "Generate image",
  spec: {
    name: "generate_image",
    description:
      "Create images from a text prompt, or edit existing images, with the user's image model. Write a detailed, self-contained prompt " +
      "(subject, style, composition, lighting, text to render). To edit or combine pictures, pass the file names of images attached or created earlier in this chat in input_images. " +
      "The images are shown to the user directly; do not describe them back in full.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image, or of the change to make" },
        aspect_ratio: { type: "string", enum: ASPECTS, description: "Default 1:1" },
        count: { type: "integer", description: "How many images, 1-4. Default 1." },
        input_images: { type: "array", items: { type: "string" }, description: "File names of images in this chat to edit or use as references" },
      },
      required: ["prompt"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Generate image: ${String(i.prompt).slice(0, 80)}`,
  async run(input, ctx) {
    if (!mediaModelFor(ctx.settings, "image")) return { isError: true, text: noMediaModelMessage("image") };
    const inputs = inputsFromNames(input.input_images, ctx);
    const { refs, modelName } = await createMedia(
      { kind: "image", prompt: String(input.prompt), inputs, options: { aspect: input.aspect_ratio as MediaOptions["aspect"], count: typeof input.count === "number" ? input.count : 1 } },
      ctx,
    );
    return { text: `Generated ${refs.length} image(s) with ${modelName}: ${refs.map((r) => r.name).join(", ")}. They are displayed to the user under this message.`, artifacts: refs };
  },
};

const generateVideoTool: Tool = {
  group: "media",
  title: "Generate video",
  spec: {
    name: "generate_video",
    description:
      "Create a short video clip from a text prompt with the user's video model, optionally starting from an image in this chat (image-to-video). " +
      "It takes minutes and costs much more than text, so only call it when the user asked for a video. Describe scene, motion, camera, sound and style.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the clip" },
        aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Default 16:9" },
        seconds: { type: "integer", description: "Length in seconds if the model allows choosing (typically 4-15)" },
        start_image: { type: "string", description: "File name of an image in this chat to animate" },
      },
      required: ["prompt"],
    },
  },
  needsApproval: () => false,
  summarize: (i) => `Generate video: ${String(i.prompt).slice(0, 80)}`,
  async run(input, ctx) {
    if (!mediaModelFor(ctx.settings, "video")) return { isError: true, text: noMediaModelMessage("video") };
    const inputs = inputsFromNames(input.start_image ? [input.start_image] : [], ctx);
    const { refs, modelName } = await createMedia(
      { kind: "video", prompt: String(input.prompt), inputs, options: { aspect: input.aspect_ratio as MediaOptions["aspect"], seconds: typeof input.seconds === "number" ? input.seconds : undefined } },
      ctx,
    );
    return { text: `Generated a video with ${modelName} (${refs[0].name}). It is displayed to the user under this message.`, artifacts: refs };
  },
};

export const mediaTools: Tool[] = [generateImage, generateVideoTool];
