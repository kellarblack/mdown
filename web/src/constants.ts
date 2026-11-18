/* What the page knows before it talks to any server. */

export const SETTINGS_KEY = "mdown.settings";
export const HISTORY_KEY = "mdown.history";
export const LEGACY_SETTINGS_KEYS = ["mget.settings", "mediadownload.settings", "trawl.settings", "spool.settings", "cobalt.studio.settings"];
export const LEGACY_HISTORY_KEYS = ["mget.history", "mediadownload.history", "trawl.history", "spool.history", "cobalt.studio.history"];
export const MAX_CONCURRENT = 5;
export const MAX_URLS_PER_SUBMIT = 10;
export const HISTORY_LIMIT = 8;

/** Put your own API here before you publish a fork, or leave it empty. */
export const DEFAULT_INSTANCE = "https://api.mdown.cc";

export const VIDEO_QUALITIES = ["4320", "2160", "1440", "1080", "720", "480", "360", "240", "144"] as const;
export const AUDIO_BITRATES = ["128", "96", "64", "8"] as const;
export const AUDIO_FORMATS = ["best", "mp3", "ogg", "wav", "opus"] as const;

export type DownloadMode = "auto" | "audio" | "video" | "mute";
export type SavingMethod = "ask" | "download" | "share" | "copy";
export type Theme = "auto" | "light" | "dark";

export interface Settings {
  schema?: number;
  instance: string;
  apiKey: string;
  downloadMode: "auto" | "audio" | "video";
  muteVideo: boolean;
  videoQuality: string;
  audioFormat: string;
  audioBitrate: string;
  audioCovers: boolean;
  filenameStyle: string;
  disableMetadata: boolean;
  alwaysProxy: boolean;
  localProcessing: string;
  subtitleLang: string;
  youtubeVideoCodec: string;
  youtubeVideoContainer: string;
  youtubeDubLang: string;
  youtubeBetterAudio: boolean;
  youtubeHLS: boolean;
  convertGif: boolean;
  allowH265: boolean;
  tiktokFullAudio: boolean;
  savingMethod: SavingMethod;
  concurrency: number;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  instance: "",
  apiKey: "",
  downloadMode: "auto",
  muteVideo: false,
  videoQuality: "1080",
  audioFormat: "mp3",
  audioBitrate: "128",
  audioCovers: true,
  filenameStyle: "basic",
  disableMetadata: false,
  alwaysProxy: false,
  localProcessing: "disabled",
  subtitleLang: "en",
  youtubeVideoCodec: "h264",
  youtubeVideoContainer: "auto",
  youtubeDubLang: "original",
  youtubeBetterAudio: false,
  youtubeHLS: false,
  convertGif: true,
  allowH265: false,
  tiktokFullAudio: false,
  savingMethod: "download",
  concurrency: 3,
  theme: "auto",
};

/** hostname suffix -> service id; drives detection and hints only */
export const SERVICE_HOSTS: [string, string][] = [
  ["youtube.com", "youtube"], ["youtu.be", "youtube"], ["youtube-nocookie.com", "youtube"],
  ["music.youtube.com", "youtube"],
  ["twitter.com", "twitter"], ["x.com", "twitter"],
  ["instagram.com", "instagram"], ["instagr.am", "instagram"],
  ["tiktok.com", "tiktok"], ["vt.tiktok.com", "tiktok"], ["douyin.com", "douyin"],
  ["reddit.com", "reddit"], ["redd.it", "reddit"],
  ["soundcloud.com", "soundcloud"], ["snd.sc", "soundcloud"], ["soundcloud.app.goo.gl", "soundcloud"],
  ["spotify.com", "spotify"], ["deezer.com", "deezer"], ["tidal.com", "tidal"], ["music.apple.com", "apple-music"],
  ["bandcamp.com", "bandcamp"], ["mixcloud.com", "mixcloud"], ["audiomack.com", "audiomack"], ["hearthis.at", "hearthis"],
  ["bilibili.com", "bilibili"], ["b23.tv", "bilibili"],
  ["vimeo.com", "vimeo"], ["dailymotion.com", "dailymotion"], ["dai.ly", "dailymotion"],
  ["twitch.tv", "twitch"], ["clips.twitch.tv", "twitch"],
  ["kick.com", "kick"], ["rumble.com", "rumble"], ["odysee.com", "odysee"],
  ["streamable.com", "streamable"], ["coub.com", "coub"],
  ["facebook.com", "facebook"], ["fb.watch", "facebook"],
  ["threads.net", "threads"], ["threads.com", "threads"],
  ["snapchat.com", "snapchat"], ["rutube.ru", "rutube"],
  ["ok.ru", "ok"], ["vk.com", "vk"], ["vkvideo.ru", "vk"],
  ["loom.com", "loom"], ["tumblr.com", "tumblr"], ["bsky.app", "bluesky"],
  ["newgrounds.com", "newgrounds"], ["pixiv.net", "pixiv"],
  ["pinterest.com", "pinterest"], ["pin.it", "pinterest"],
  ["xiaohongshu.com", "xiaohongshu"], ["imgur.com", "imgur"],
  ["giphy.com", "giphy"], ["tenor.com", "tenor"], ["9gag.com", "9gag"],
];

export const HIDDEN_SERVICES = new Set(["pinterest"]);

export const SERVICE_ALIASES: Record<string, string> = {
  "yout.cc": "youtube.com", "youtu.cc": "youtube.com", "sound.cc": "soundcloud.com",
  "insta.cc": "instagram.com", "tiktok.cc": "tiktok.com", "twitch.cc": "twitch.tv",
  "vimeo.cc": "vimeo.com", "reddit.cc": "reddit.com",
};

export const APP_PATHS = new Set(["", "index.html"]);

/** no video worth having: these queue as audio */
export const AUDIO_FIRST = new Set(["soundcloud", "bandcamp", "mixcloud", "audiomack", "hearthis"]);
/** a link here is usually a song; youtube carries video too, so it is only a hint */
export const MUSIC_FIRST = new Set(["youtube", ...AUDIO_FIRST]);
export const IMAGE_SERVICES = new Set(["imgur", "giphy", "tenor", "pixiv"]);

export const DRM_SERVICES = new Map<string, string>([
  ["spotify", "Spotify audio is encrypted, so this can't download from it. The same track is usually on YouTube or SoundCloud."],
  ["deezer", "Deezer audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."],
  ["tidal", "Tidal audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."],
  ["apple-music", "Apple Music audio is encrypted, so this can't download from it. Try the same track on YouTube or SoundCloud."],
]);

export const ERROR_TEXT: Record<string, string> = {
  "api.url.invalid": "That link isn't valid for any supported service.",
  "api.url.unsupported": "This service isn't supported by the instance.",
  "api.url.missing": "No link was sent.",
  "api.url.invalid_input": "The instance rejected that input.",
  "api.service.unsupported": "This service isn't supported by the instance.",
  "api.service.disabled": "This service is disabled on the instance.",
  "api.service.not_implemented": "This service isn't implemented yet.",
  "api.content.video.unavailable": "The video is unavailable.",
  "api.content.video.live": "Live streams can't be downloaded.",
  "api.content.video.private": "The video is private.",
  "api.content.video.age": "The video is age-restricted; the instance can't access it.",
  "api.content.video.region": "The video is region-locked.",
  "api.content.video.payment": "The video requires a paid subscription.",
  "api.content.too_long": "The media is longer than this instance allows.",
  "api.content.video.too_long": "The video is longer than this instance allows.",
  "api.content.post.unavailable": "The post is unavailable.",
  "api.content.post.private": "The post is private.",
  "api.content.post.age": "The post is age-restricted.",
  "api.content.post.region": "The post is region-locked.",
  "api.content.short_link.unsupported": "Short links from this service aren't supported.",
  "api.rate_limit": "Rate limit reached. Try again in a moment.",
  "api.auth.apikey.missing": "This instance needs an API key. Add it in Settings → Server.",
  "api.auth.apikey.invalid": "That API key was rejected. Check it in Settings → Server.",
  "api.auth.bearer.missing": "This instance requires a session token.",
  "api.auth.bearer.invalid": "The session token was rejected.",
  "api.auth.turnstile.missing": "The bot check did not finish. Reload and try once.",
  "api.auth.turnstile.invalid": "The bot check failed. Reload and try once.",
  "api.instance.version_mismatch": "This API version isn't supported.",
  "api.instance.not_ready": "The instance is still starting up.",
  "api.instance.timed_out": "The instance took too long and gave up. Try a shorter link.",
  "api.auth.origin": "This instance only answers its own site.",
  "api.content.too_large": "The file would be bigger than this instance allows.",
  "api.content.drm": "Encrypted by the service, so it can't be downloaded. On SoundCloud this usually means a major-label release.",
  "api.content.login": "This service only gives files to logged-in accounts when the request comes from a server, and this one does not use an account. Retrying will not help.",
  "api.service.unavailable": "This service is refusing this server right now. Try again later; blocks like this often clear within a day.",
};

/** a phone, or a landscape phone that reports no hover */
export const PHONE_QUERY = "(max-width: 720px), (hover: none) and (max-height: 520px)";
export const isPhone = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

/** past this, the tunnel goes to the browser's own download manager */
export const LARGE_FILE_BYTES = 200 * 1024 * 1024;
/** past this, a download is a decision, not a surprise */
export const XL_BYTES = 250 * 1024 * 1024;
