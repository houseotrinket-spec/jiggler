import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import { Parser } from "json2csv";
import path from "path";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const SEARCHSPRING_SITE_ID = "bmcyq0";
const SEARCHSPRING_INSTANCE = "bmcyq0";
const DATA_FILE = "./products.json";

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

let productStore = {};
let trackedInputs = [];

if (fs.existsSync(DATA_FILE)) {
  productStore = JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(productStore, null, 2));
}

function md5(value) {
  return crypto.createHash("md5").update(value.toString()).digest("hex");
}

function extractProductId(input) {
  if (!input) return null;

  const cartMatch = input.match(/product_id=(\d+)/);
  if (cartMatch) return cartMatch[1];

  const imageMatch = input.match(/\/products\/(\d+)\//);
  if (imageMatch) return imageMatch[1];

  if (/^\d+$/.test(input)) return input;

  return null;
}

/* ================= EMAIL ALERT ================= */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.ALERT_EMAIL,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

async function sendAlert(subject, text) {
  if (!process.env.ALERT_EMAIL) return;

  await transporter.sendMail({
    from: process.env.ALERT_EMAIL,
    to: process.env.ALERT_EMAIL,
    subject,
    text
  });
}

/* ================= Searchspring ================= */

async function fetchProduct(identifier) {
  const searchUrl = `https://${SEARCHSPRING_INSTANCE}.a.searchspring.io/api/search/search.json?siteId=${SEARCHSPRING_SITE_ID}&q=${encodeURIComponent(identifier)}&resultsFormat=native&page=1&size=5`;

  try {
    const res = await axios.get(searchUrl);
    const results = res.data.results || [];
    if (!results.length) return null;

    const item = results[0];

    const searchspringId = item.id;
    const productUrl = item.url;
    const name = item.name;
    const price = item.price;
    const sku = item.sku;
    const availability = item.available ? "in_stock" : "out_of_stock";
    const inventory = item.inventory || 0;

    const htmlData = await fetchBigCommerceHTML(productUrl);

    return {
      searchspringId,
      name,
      productUrl,
      price,
      sku,
      availability,
      inventory,
      ...htmlData
    };

  } catch (err) {
    console.error("Searchspring error:", err.message);
    return null;
  }
}

/* ================= HTML PARSER ================= */

async function fetchBigCommerceHTML(productUrl) {
  try {
    const res = await axios.get(productUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const html = res.data;
    const $ = cheerio.load(html);

    let bcEntityId = null;
    let bcApiId = null;
    let variants = [];

    $("script").each((i, el) => {
      const scriptText = $(el).html();
      if (scriptText && scriptText.includes("entityId")) {
        try {
          const match = scriptText.match(/\{.*"entityId":.*\}/s);
          if (match) {
            const parsed = JSON.parse(match[0]);
            bcEntityId = parsed.entityId;
            bcApiId = parsed.id;

            if (parsed.variants) {
              variants = parsed.variants.map(v => ({
                variantEntityId: v.entityId,
                variantApiId: v.id,
                sku: v.sku,
                inventory: v.inventory
              }));
            }
          }
        } catch {}
      }
    });

    const images = [];
    $("img").each((i, el) => {
      const src = $(el).attr("src");
      if (src && src.includes("cdn11.bigcommerce.com")) {
        images.push(src.split("?")[0]);
      }
    });

    return {
      bigcommerceEntityId: bcEntityId,
      bigcommerceApiId: bcApiId,
      variants,
      images: [...new Set(images)]
    };

  } catch (err) {
    console.error("HTML fetch error:", err.message);
    return {};
  }
}

/* ================= PROCESSOR ================= */

async function processInput(input) {
  const productId = extractProductId(input);
  const identifier = productId || input;

  const data = await fetchProduct(identifier);
  if (!data) return null;

  const now = new Date().toISOString();
  const key = data.bigcommerceEntityId;

  if (!productStore[key]) {
    productStore[key] = {
      firstSeenAvailable: data.inventory > 0 ? now : null,
      lastSeenAvailable: data.inventory > 0 ? now : null,
      previousInventory: data.inventory,
      variants: {}
    };

    await sendAlert(
      "New Product Added",
      `${data.name} is now being tracked.`
    );
  } else {
    const record = productStore[key];

    if (record.previousInventory === 0 && data.inventory > 0) {
      await sendAlert(
        "Product Restocked",
        `${data.name} is back in stock.`
      );
    }

    record.previousInventory = data.inventory;
    if (data.inventory > 0) {
      record.lastSeenAvailable = now;
    }
  }

  saveStore();

  return {
    "Searchspring ID": data.searchspringId,
    "BigCommerce Entity ID": data.bigcommerceEntityId,
    "BigCommerce API ID": data.bigcommerceApiId,
    "Product Name": data.name,
    "Product Page URL": data.productUrl,
    "Cart Link": `https://us.jellycat.com/cart.php?action=add&product_id=${data.bigcommerceEntityId}`,
    "BigCommerce Images (JSON)": JSON.stringify(data.images),
    "Hashed URL": md5(`https://us.jellycat.com/cart.php?action=add&product_id=${data.bigcommerceEntityId}`),
    "SKU": data.sku,
    "Variants (JSON)": JSON.stringify(data.variants),
    "Availability": data.availability,
    "Inventory": data.inventory,
    "Price": data.price
  };
}

/* ================= POLLING ================= */

async function pollProducts() {
  if (!trackedInputs.length) return;

  console.log("Polling products...");
  for (const input of trackedInputs) {
    await processInput(input);
  }
}

setInterval(pollProducts, POLL_INTERVAL);

/* ================= ROUTES ================= */

app.post("/resolve", async (req, res) => {
  const { inputs } = req.body;
  if (!Array.isArray(inputs))
    return res.status(400).json({ error: "Provide array of inputs" });

  trackedInputs.push(...inputs);

  const promises = inputs.map(input => processInput(input));
  const results = (await Promise.all(promises)).filter(Boolean);

  res.json(results);
});

app.get("/export-csv", (req, res) => {
  const fields = Object.keys(productStore[Object.keys(productStore)[0]] || {});
  const parser = new Parser({ fields });
  const csv = parser.parse(Object.values(productStore));

  res.header("Content-Type", "text/csv");
  res.attachment("products.csv");
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Jiggler running on port ${PORT}`);
});
