import express from "express"
import axios from "axios"
import * as cheerio from "cheerio"
import crypto from "crypto"
import nodemailer from "nodemailer"
import pLimit from "p-limit"
import { Low } from "lowdb"
import { JSONFile } from "lowdb/node"

const app = express()
app.use(express.json())
app.use(express.static("public"))

const limit = pLimit(6)
const POLL_INTERVAL = 5 * 60 * 1000
const EMAIL_TO = "houseotrinket@gmail.com"

/* ================= DATABASE ================= */

const adapter = new JSONFile("db.json")
const db = new Low(adapter, { products: [] })
await db.read()

/* ================= EMAIL ================= */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
})

async function sendEmail(subject, body) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: EMAIL_TO,
    subject,
    text: body
  })
}

/* ================= HELPERS ================= */

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex")
}

function extractProductIdFromCart(url) {
  const match = url.match(/product_id=([^&]+)/)
  return match ? match[1] : null
}

/* ================= SEARCHSPRING ================= */

async function searchspringLookup(query) {
  try {
    const res = await axios.get(
      `https://bmcyq0.a.searchspring.io/api/search/search.json`,
      { params: { siteId: "bmcyq0", q: query, resultsFormat: "native" } }
    )
    return res.data?.results?.[0] || null
  } catch {
    return null
  }
}

/* ================= BIGCOMMERCE DIRECT ================= */

async function bigcommerceLookup(id) {
  try {
    const res = await axios.get(
      `https://us.jellycat.com/api/storefront/products/${id}`
    )
    return res.data || null
  } catch {
    return null
  }
}

/* ================= PAGE SCRAPER ================= */

async function scrapeProductPage(url) {
  try {
    const res = await axios.get(url)
    const $ = cheerio.load(res.data)

    const pageJson = JSON.parse(
      $("#__NEXT_DATA__").html() || "{}"
    )

    const product =
      pageJson?.props?.pageProps?.product ||
      pageJson?.props?.initialProps?.pageProps?.product

    if (!product) return null

    return {
      numericProductId: product.entityId,
      name: product.name,
      sku: product.sku,
      price: product.prices?.price?.value || 0,
      image:
        product.defaultImage?.urlOriginal ||
        product.images?.[0]?.urlOriginal ||
        "",
      variants: (product.variants || []).map(v => ({
        variantId: v.entityId,
        sku: v.sku,
        inventory: v.inventory?.aggregated?.availableToSell || 0
      }))
    }
  } catch {
    return null
  }
}

/* ================= HYBRID RESOLVER ================= */

async function resolveInput(input) {
  let numericProductId = null
  let productUrl = null

  if (/^\d+$/.test(input)) {
    numericProductId = input
  }

  if (input.includes("cart.php")) {
    numericProductId = extractProductIdFromCart(input)
  }

  if (input.includes("jellycat.com") && !input.includes("cart.php")) {
    productUrl = input
  }

  // Run lookups in parallel
  const [ssResult, bcResult] = await Promise.all([
    searchspringLookup(input),
    numericProductId ? bigcommerceLookup(numericProductId) : null
  ])

  if (ssResult?.url) {
    productUrl = "https://us.jellycat.com" + ssResult.url
  }

  if (!productUrl && bcResult?.custom_url?.url) {
    productUrl = "https://us.jellycat.com" + bcResult.custom_url.url
  }

  if (!productUrl) return null

  const scraped = await scrapeProductPage(productUrl)
  if (!scraped) return null

  const merged = {
    ...scraped,
    searchspringId: ssResult?.id || null,
    searchspringProductId: ssResult?.uid || null,
    bigcommerceApiId: bcResult?.id || null,
    productUrl,
    hashedId: md5(scraped.numericProductId.toString())
  }

  const exists = db.data.products.find(
    p => p.numericProductId === merged.numericProductId
  )

  if (!exists) {
    db.data.products.push({
      ...merged,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    })
    await db.write()
  }

  return merged
}

/* ================= POLLER ================= */

async function checkProduct(product) {
  const fresh = await scrapeProductPage(product.productUrl)
  if (!fresh) return

  const existing = db.data.products.find(
    p => p.numericProductId === product.numericProductId
  )

  existing.lastSeen = Date.now()

  for (const freshVar of fresh.variants) {
    const oldVar = existing.variants.find(
      v => v.variantId === freshVar.variantId
    )

    if (oldVar?.inventory === 0 && freshVar.inventory > 0) {
      await sendEmail(
        "🔁 Restock Alert",
        `${fresh.name}\nSKU: ${freshVar.sku}\n${product.productUrl}`
      )
    }
  }

  existing.variants = fresh.variants
  existing.price = fresh.price
  existing.image = fresh.image

  await db.write()
}

async function pollAll() {
  const products = [...db.data.products]
  await Promise.all(products.map(p => limit(() => checkProduct(p))))
}

setInterval(pollAll, POLL_INTERVAL)

/* ================= ROUTES ================= */

app.post("/resolve-add", async (req, res) => {
  const { inputs } = req.body
  const results = await Promise.all(
    inputs.map(i => limit(() => resolveInput(i)))
  )
  res.json(results.filter(Boolean))
})

app.get("/products", (req, res) => {
  res.json(db.data.products)
})

app.listen(process.env.PORT || 3000, () =>
  console.log("Jiggler Enterprise Hybrid Running")
)
