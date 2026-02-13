import express from "express";
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import { Parser } from "json2csv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const SEARCHSPRING_SITE_ID = "bmcyq0";
const SEARCHSPRING_INSTANCE = "bmcyq0";
const DATA_FILE = "./products.json";

let productStore = {};

if (fs.existsSync(DATA_FILE)) {
  productStore = JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveStore() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(productStore, null, 2));
}

/* ================= Utilities ================= */

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

/* ================= Searchspring ================= */
async function fetchProduct(identifier) {
  const searchUrl = `https://${SEARCHSPRING_INSTANCE}.a.searchspring.io/api/search/search.json?siteId=${SEARCHSPRING_SITE_ID}&q=${encodeURIComponent(identifier)}&resultsFormat=native&page=1&size=5`;

  try {
    const res = await axios.get(searchUrl);
    const results = res.data.results || [];
    if (!results.length) return null;

    const item = results[0];

    const searchspringId = item.id || null;
    const productUrl = item.url || "";

    const gqlData = await fetchBigCommerceGraphQL(productUrl);

    return {
      searchspringId,
      productEntityId: gqlData?.productEntityId || null,
      productApiId: gqlData?.productApiId || null,
      name: item.name,
      sku: item.sku || "",
      availability: item.availability || "unknown",
      inventory: item.inventory_level ?? 0,
      price: item.price || "",
      productUrl,
      images: gqlData?.images || [],
      variants: gqlData?.variants || []
    };

  } catch (err) {
    console.error("Searchspring error:", err.message);
    return null;
  }
}

////////
import cheerio from "cheerio";

import cheerio from "cheerio";

async function fetchBigCommerceGraphQL(productUrl) {
  if (!productUrl) return null;

  try {
    const res = await axios.get(productUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(res.data);

    let stateJSON = null;

    $("script").each((i, el) => {
      const scriptText = $(el).html();

      if (scriptText && scriptText.includes("__INITIAL_STATE__")) {
        const match = scriptText.match(/__INITIAL_STATE__\s*=\s*(\{.*\});/s);
        if (match) {
          stateJSON = JSON.parse(match[1]);
        }
      }

      if (scriptText && scriptText.includes("BCData")) {
        const match = scriptText.match(/BCData\s*=\s*(\{.*\});/s);
        if (match) {
          stateJSON = JSON.parse(match[1]);
        }
      }
    });

    if (!stateJSON) return null;

    const product =
      stateJSON.product ||
      stateJSON.products?.current ||
      stateJSON.data?.product ||
      null;

    if (!product) return null;

    const productEntityId = product.entityId || null;
    const productApiId = product.id || null;

    const variants = (product.variants || []).map(v => ({
      variantEntityId: v.entityId || null,
      variantApiId: v.id || null,
      sku: v.sku || null,
      inventory: v.inventory || v.inventoryLevel || 0,
      isInStock: v.isInStock ?? null,
      optionValues: v.optionValues || []
    }));

    const images = (product.images || []).map(img =>
      img.urlOriginal || img.urlStandard || img.urlThumbnail
    );

    return {
      productEntityId,
      productApiId,
      variants,
      images
    };

  } catch (err) {
    console.error("GraphQL extraction error:", err.message);
    return null;
  }
}

/* ================= Processor ================= */

async function processInput(input) {
  const productId = extractProductId(input);
  const identifier = productId || input;

  const data = await fetchProduct(identifier);
  if (!data) return null;

  const now = new Date().toISOString();
  const cartLink = `https://us.jellycat.com/cart.php?action=add&product_id=${data.productId}`;
  const hashedUrl = md5(cartLink);

  if (!productStore[data.productEntityId]) {
    productStore[data.productEntityId] = {
      firstSeenAvailable: data.inventory > 0 ? now : null,
      lastSeenAvailable: data.inventory > 0 ? now : null,
      previousInventory: data.inventory,
      variants: {}
    };
  }
  
  const record = productStore[data.productEntityId];
  
  // Track each variant
  data.variants.forEach(variant => {
    if (!record.variants[variant.variantEntityId]) {
      record.variants[variant.variantEntityId] = {
        sku: variant.sku,
        previousInventory: variant.inventory,
        firstSeenAvailable: variant.inventory > 0 ? now : null,
        lastSeenAvailable: variant.inventory > 0 ? now : null
      };
    } else {
      const vRecord = record.variants[variant.variantEntityId];

    if (variant.inventory > 0 && !vRecord.firstSeenAvailable) {
      vRecord.firstSeenAvailable = now;
    }

    if (variant.inventory > 0) {
      vRecord.lastSeenAvailable = now;
    }

    vRecord.previousInventory = variant.inventory;
  }
});


  saveStore();
    return {
    "Searchspring ID": data.searchspringId,
    "BigCommerce Product ID": data.bigcommerceProductId,
    "Product Name": data.name,
  
    "Product Page URL": data.productUrl,
    "Cart Link": data.bigcommerceProductId
      ? `https://us.jellycat.com/cart.php?action=add&product_id=${data.bigcommerceProductId}`
      : "",
  
    "Searchspring Image URL": data.searchspringImage,
    "BigCommerce Image URL": data.bigcommerceImage,
  
    "Date First Seen/Available":
      productStore[data.bigcommerceProductId]?.firstSeenAvailable || null,
  
    "Date Last Seen/Available":
      productStore[data.bigcommerceProductId]?.lastSeenAvailable || null,
  
    "Hashed URL": data.bigcommerceProductId
      ? md5(`https://us.jellycat.com/cart.php?action=add&product_id=${data.bigcommerceProductId}`)
      : "",
  
    "SKU": data.sku,
   "Variants (JSON)": JSON.stringify(data.variants),
   "Variant Tracking (JSON)": JSON.stringify(productStore[data.productEntityId]?.variants || {})

  
    "Availability": data.availability,
    "Inventory": data.inventory,
    "Price": data.price
  };
}

/* ================= Routes ================= */

app.post("/resolve", async (req, res) => {
  const { inputs } = req.body;
  if (!Array.isArray(inputs))
    return res.status(400).json({ error: "Provide array of inputs" });

  const promises = inputs.map(input => processInput(input));
  const results = (await Promise.all(promises)).filter(Boolean);

  res.json(results);
});

app.get("/export-csv", (req, res) => {
   const fields = [
    "Searchspring ID",
    "BigCommerce Product ID",
    "Product Name",
    "Product Page URL",
    "Cart Link",
    "Searchspring Image URL",
    "BigCommerce Image URL",
    "Date First Seen/Available",
    "Date Last Seen/Available",
    "Hashed URL",
    "SKU",
    "Variant IDs (JSON)",
    "Availability",
    "Inventory",
    "Price"
  ];
  const records = Object.keys(productStore).map(id => {
    return {
      "Product ID": id,
      ...productStore[id]
    };
  });

  const parser = new Parser({ fields });
  const csv = parser.parse(records);

  res.header("Content-Type", "text/csv");
  res.attachment("products.csv");
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
