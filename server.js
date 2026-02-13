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

const limit = pLimit(5)
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

function extractNumericIdFromImage(url) {
  const match = url.match(/products\/(\d+)\//)
  return match ? match[1] : null
}

async function fetchSearchspring(productId) {
  try {
    const res = await axios.get(
      `https://bmcyq0.a.searchspring.io/api/search/search.json?siteId=bmcyq0&q=${productId}&resultsFormat=native`
    )
    return res.data?.results?.[0] || null
  } catch {
    return null
  }
}

async function scrapeProductPage(url) {
  try {
    const res = await axios.get(url)
    const $ = cheerio.load(res.data)

    const pageJson = JSON.parse(
      $("#__NEXT_DATA__").html() || "{}"
    )

    const productData =
      pageJson?.props?.pageProps?.product ||
      pageJson?.props?.initialProps?.pageProps?.product

    if (!productData) return null

    return {
      numericProductId: productData.entityId,
      name: productData.name,
      price: productData.prices?.price?.value || 0,
      sku: productData.sku || "",
      image:
        productData.defaultImage?.urlOriginal ||
        productData.images?.[0]?.urlOriginal ||
        "",
      url,
      variants: (productData.variants || []).map(v => ({
        variantId: v.entityId,
        sku: v.sku,
        inventory: v.inventory?.aggregated?.availableToSell || 0
      }))
    }
  } catch {
    return null
  }
}

/* ================= RESOLVER ================= */

async function resolveInput(input) {
  let productUrl = null
  let numericProductId = null

  if (input.includes("cart.php")) {
    numericProductId = extractProductIdFromCart(input)
  }

  if (input.includes("/products/")) {
    numericProductId = extractNumericIdFromImage(input)
  }

  if (input.includes("jellycat.com") && !input.includes("cart.php")) {
    productUrl = input
  }

  if (!productUrl && numericProductId) {
    const ss = await fetchSearchspring(numericProductId)
    if (ss?.url) {
      productUrl = "https://us.jellycat.com" + ss.url
    }
  }

  if (!productUrl) return null

  const product = await scrapeProductPage(productUrl)
  if (!product) return null

  const existing = db.data.products.find(
    p => p.numericProductId === product.numericProductId
  )

  if (!existing) {
    db.data.products.push({
      ...product,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    })
    await db.write()
  }

  return product
}

/* ================= POLLER ================= */

async function checkProduct(product) {
  const fresh = await scrapeProductPage(product.url)
  if (!fresh) return

  const existing = db.data.products.find(
    p => p.numericProductId === fresh.numericProductId
  )

  existing.lastSeen = Date.now()

  for (const freshVariant of fresh.variants) {
    const oldVariant = existing.variants.find(
      v => v.variantId === freshVariant.variantId
    )

    if (oldVariant?.inventory === 0 && freshVariant.inventory > 0) {
      await sendEmail(
        "🔁 Restock Alert",
        `${fresh.name}\nSKU: ${freshVariant.sku}\n${fresh.url}`
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
  console.log("Jiggler Running")
)
