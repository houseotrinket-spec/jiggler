import express from "express"
import axios from "axios"
import cheerio from "cheerio"
import crypto from "crypto"
import nodemailer from "nodemailer"
import pLimit from "p-limit"
import { Low } from "lowdb"
import { JSONFile } from "lowdb/node"

const app = express()
app.use(express.json())
app.use(express.static("public"))

/* ==============================
   CONFIG
============================== */

const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
const EMAIL_TO = "houseotrinket@gmail.com"

const limit = pLimit(5)

/* ==============================
   DATABASE
============================== */

const adapter = new JSONFile("db.json")
const db = new Low(adapter, { products: [] })
await db.read()

/* ==============================
   EMAIL SETUP (GMAIL APP PASS)
============================== */

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

/* ==============================
   HELPERS
============================== */

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex")
}

function extractProductIdFromCart(url) {
  const match = url.match(/product_id=([^&]+)/)
  return match ? match[1] : null
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

    const numericProductId = productData.entityId
    const name = productData.name
    const price = productData.prices?.price?.value || 0
    const sku = productData.sku || ""
    const image =
      productData.defaultImage?.urlOriginal ||
      productData.images?.[0]?.urlOriginal ||
      ""

    const variants = (productData.variants || []).map(v => ({
      variantId: v.entityId,
      sku: v.sku,
      inventory: v.inventory?.aggregated?.availableToSell || 0
    }))

    return {
      numericProductId,
      name,
      price,
      sku,
      image,
      variants,
      url
    }
  } catch {
    return null
  }
}

/* ==============================
   INVENTORY CHECK LOGIC
============================== */

async function checkProduct(product) {
  const fresh = await scrapeProductPage(product.url)
  if (!fresh) return

  const existing = db.data.products.find(
    p => p.numericProductId === fresh.numericProductId
  )

  if (!existing) {
    // NEW PRODUCT
    db.data.products.push({
      ...fresh,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    })
    await db.write()

    await sendEmail(
      "🆕 New Product Detected",
      `${fresh.name}\n${fresh.url}\nPrice: ${fresh.price}`
    )
    return
  }

  existing.lastSeen = Date.now()

  // Check restock per variant
  for (const freshVariant of fresh.variants) {
    const oldVariant = existing.variants.find(
      v => v.variantId === freshVariant.variantId
    )

    if (!oldVariant) continue

    if (oldVariant.inventory === 0 && freshVariant.inventory > 0) {
      await sendEmail(
        "🔁 Restock Alert",
        `${fresh.name}\nSKU: ${freshVariant.sku}\nInventory: ${freshVariant.inventory}\n${fresh.url}`
      )
    }
  }

  existing.variants = fresh.variants
  existing.price = fresh.price
  existing.image = fresh.image

  await db.write()
}

/* ==============================
   ROLLING POLLER
============================== */

async function pollAll() {
  console.log("Polling products...")

  const products = [...db.data.products]

  await Promise.all(
    products.map(p => limit(() => checkProduct(p)))
  )

  console.log("Polling complete")
}

setInterval(pollAll, POLL_INTERVAL)

/* ==============================
   API ROUTES
============================== */

app.post("/add", async (req, res) => {
  const { url } = req.body
  const product = await scrapeProductPage(url)

  if (!product) return res.status(400).json({ error: "Invalid product" })

  const exists = db.data.products.find(
    p => p.numericProductId === product.numericProductId
  )

  if (!exists) {
    db.data.products.push({
      ...product,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    })
    await db.write()
  }

  res.json(product)
})

app.get("/products", (req, res) => {
  res.json(db.data.products)
})

/* ==============================
   START SERVER
============================== */

app.listen(process.env.PORT || 3000, () =>
  console.log("Jiggler Inventory Monitor Running")
)


