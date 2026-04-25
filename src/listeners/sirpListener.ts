import { Listener } from "@sapphire/framework";
import { Client, EmbedBuilder, Events } from "discord.js";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

type SirpArticle = {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
};

type SirpCheckOptions = {
  forcePostLatest?: boolean;
};

type SirpCheckResult = {
  ok: boolean;
  message: string;
  fetched: number;
  posted: number;
};

type SendableChannel = {
  send: (payload: { embeds: EmbedBuilder[] }) => Promise<unknown>;
};

const PAGE_URL = "https://www.sirp.ee/category/kunst/";
const FEED_URL = "https://www.sirp.ee/category/kunst/feed/";
const SEEN_FILE = path.join(process.cwd(), "data", "sirp-kunst-seen.json");

const ENABLE_AUTOMATIC_CHECK = true;
const CHECK_INTERVAL_MINUTES = 300;
const POST_EXISTING_ON_FIRST_RUN = false;
const MAX_POSTS_PER_CHECK = 5;

const USER_AGENT =
  "Kiisukas-v-2 Discord bot (+https://www.sirp.ee/category/kunst/)";

let timer: NodeJS.Timeout | null = null;
let isChecking = false;

const parser = new Parser({
  headers: {
    "User-Agent": USER_AGENT,
  },
});

export class SirpKunstListener extends Listener {
  public constructor(context: Listener.Context, options: Listener.Options) {
    super(context, {
      ...options,
      event: Events.ClientReady,
      once: true,
    });
  }

  public run(client: Client) {
    if (!ENABLE_AUTOMATIC_CHECK) return;

    startSirpKunstNews(client);
  }
}

function startSirpKunstNews(client: Client) {
  if (timer) return;

  const intervalMs = Math.max(CHECK_INTERVAL_MINUTES, 5) * 60_000;

  void runSirpKunstCheck(client);

  timer = setInterval(() => {
    void runSirpKunstCheck(client);
  }, intervalMs);

  console.log(
    `[Sirp] Kunsti uudiste automaatne kontroll käivitatud (${CHECK_INTERVAL_MINUTES} min).`,
  );
}

export async function runSirpKunstCheck(
  client: Client,
  options: SirpCheckOptions = {},
): Promise<SirpCheckResult> {
  if (isChecking) {
    return {
      ok: false,
      message: "Sirbi kontroll juba käib. Proovi mõne sekundi pärast uuesti.",
      fetched: 0,
      posted: 0,
    };
  }

  isChecking = true;

  try {
    const channelId = process.env.SIRP_KUNST_CHANNEL_ID;

    if (!channelId) {
      return {
        ok: false,
        message: "SIRP_KUNST_CHANNEL_ID puudub .env failist.",
        fetched: 0,
        posted: 0,
      };
    }

    const channel = await client.channels.fetch(channelId);

    if (!isSendableChannel(channel)) {
      return {
        ok: false,
        message:
          "Sirbi kanalit ei leitud või kanal ei toeta sõnumite saatmist.",
        fetched: 0,
        posted: 0,
      };
    }

    const articles = await getSirpKunstArticles();

    if (articles.length === 0) {
      return {
        ok: false,
        message: "Sirbi Kunst rubriigist ei leitud ühtegi artiklit.",
        fetched: 0,
        posted: 0,
      };
    }

    const seen = await readSeen();

    if (options.forcePostLatest) {
      const latestArticle = articles[0];

      await postArticle(channel, latestArticle, true);

      for (const article of articles) {
        seen.add(articleKey(article.link));
      }

      await writeSeen(seen);

      return {
        ok: true,
        message: `Testpostitus tehtud: ${latestArticle.title}`,
        fetched: articles.length,
        posted: 1,
      };
    }

    const firstRun = seen.size === 0;

    if (firstRun && !POST_EXISTING_ON_FIRST_RUN) {
      for (const article of articles) {
        seen.add(articleKey(article.link));
      }

      await writeSeen(seen);

      return {
        ok: true,
        message: `Esimene käivitus: ${articles.length} artiklit märgiti nähtuks. Postitusi ei saadetud.`,
        fetched: articles.length,
        posted: 0,
      };
    }

    const newArticles = articles.filter(
      (article) => !seen.has(articleKey(article.link)),
    );

    if (newArticles.length === 0) {
      return {
        ok: true,
        message: `Fetch õnnestus. Uusi Sirbi Kunst artikleid ei ole. Kontrollitud artikleid: ${articles.length}.`,
        fetched: articles.length,
        posted: 0,
      };
    }

    const articlesToPost = newArticles.slice(0, MAX_POSTS_PER_CHECK).reverse();

    for (const article of articlesToPost) {
      await postArticle(channel, article, false);
      console.log(`[Sirp] Postitatud: ${article.title}`);
    }

    for (const article of newArticles) {
      seen.add(articleKey(article.link));
    }

    await writeSeen(seen);

    return {
      ok: true,
      message: `Postitasin ${articlesToPost.length} uut Sirbi Kunst artiklit.`,
      fetched: articles.length,
      posted: articlesToPost.length,
    };
  } catch (error) {
    console.error("[Sirp] Kunst uudiste kontroll ebaõnnestus:", error);

    return {
      ok: false,
      message:
        "Sirbi kontroll ebaõnnestus. Vaata täpsemat errorit terminalist.",
      fetched: 0,
      posted: 0,
    };
  } finally {
    isChecking = false;
  }
}

async function postArticle(
  channel: SendableChannel,
  article: SirpArticle,
  isTestPost: boolean,
) {
  const embed = new EmbedBuilder()
    .setColor(0x71368a)
    .setTitle(article.title)
    .setURL(article.link)
    .setDescription(article.description || "Uus kunstiuudis Sirbis.")
    .addFields({
      name: "Allikas",
      value: "Sirp / Kunst",
      inline: true,
    })
    .setFooter({
      text: isTestPost ? "Testpostitus" : "Sirbi automaatpostitus",
    });

  const timestamp = article.pubDate ? new Date(article.pubDate) : new Date();

  embed.setTimestamp(
    Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
  );

  await channel.send({ embeds: [embed] });
}

async function getSirpKunstArticles(): Promise<SirpArticle[]> {
  try {
    return await getArticlesFromRss();
  } catch (error) {
    console.warn("[Sirp] RSS lugemine ebaõnnestus, proovin HTML lehte:", error);
    return await getArticlesFromHtml();
  }
}

async function getArticlesFromRss(): Promise<SirpArticle[]> {
  const feed = await parser.parseURL(FEED_URL);

  return feed.items
    .filter((item) => item.title && item.link)
    .map((item) => ({
      title: cleanText(item.title ?? ""),
      link: item.link ?? "",
      description: cleanText(
        item.contentSnippet ||
          item.summary ||
          item.content ||
          "Uus kunstiuudis Sirbis.",
      ).slice(0, 500),
      pubDate: item.isoDate || item.pubDate,
    }));
}

async function getArticlesFromHtml(): Promise<SirpArticle[]> {
  const html = await fetchText(PAGE_URL);
  const $ = cheerio.load(html);

  const articles: SirpArticle[] = [];
  const usedLinks = new Set<string>();

  $("h2 a, h3 a, article a").each((_, element) => {
    const title = cleanText($(element).text());
    const href = $(element).attr("href");

    if (!title || !href) return;

    const link = new URL(href, PAGE_URL).toString();
    const key = articleKey(link);

    if (!link.includes("sirp.ee")) return;
    if (usedLinks.has(key)) return;
    if (title.length < 4) return;

    usedLinks.add(key);

    articles.push({
      title,
      link,
      description: "Uus kunstiuudis Sirbis.",
    });
  });

  return articles.slice(0, 20);
}

async function readSeen(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(SEEN_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) return new Set();

    return new Set(data.filter((value) => typeof value === "string"));
  } catch {
    return new Set();
  }
}

async function writeSeen(seen: Set<string>) {
  await fs.mkdir(path.dirname(SEEN_FILE), { recursive: true });

  const latest = Array.from(seen).slice(-500);

  await fs.writeFile(SEEN_FILE, JSON.stringify(latest, null, 2), "utf8");
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as SendableChannel).send === "function"
  );
}

function articleKey(link: string) {
  return link.split("#")[0].replace(/\/$/, "").toLowerCase();
}

function cleanText(value: string) {
  return cheerio.load(value).text().replace(/\s+/g, " ").trim();
}

function fetchText(url: string, redirectsLeft = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "http:" ? http : https;

    const request = client.get(
      parsedUrl,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;

        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          response.headers.location &&
          redirectsLeft > 0
        ) {
          response.resume();

          const nextUrl = new URL(response.headers.location, url).toString();
          resolve(fetchText(nextUrl, redirectsLeft - 1));
          return;
        }

        if (statusCode >= 400) {
          response.resume();
          reject(new Error(`HTTP ${statusCode}`));
          return;
        }

        response.setEncoding("utf8");

        let body = "";

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          resolve(body);
        });
      },
    );

    request.setTimeout(15_000, () => {
      request.destroy(new Error("Request timeout"));
    });

    request.on("error", reject);
  });
}
