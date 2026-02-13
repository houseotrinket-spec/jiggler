import express from "express"
import axios from "axios"
import cheerio from "cheerio"
import crypto from "crypto"
import pLimit from "p-limit"

const app = express()
app.use(express.json())
app.use(express.static("public"))

const limit = pLimit(5)

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
  const res = await axios.get(url)
  const $ = cheerio.load(res.data)

  const pageJson = JSON.parse(
    $("#__NEXT_DATA__").html() || "{}"
  )

  const productData =
    pageJson?.props?.pageProps?.product ||
    pageJson?.props?.initialProps?.pageProps?.product ||
    null

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
    variants
  }
}

async function resolveInput(input) {
  let productUrl = null
  let cartUrl = null
  let numericProductId = null
  let hashedId = null
  let searchspringId = null
  let name = ""
  let price = 0
  let sku = ""
  let image = ""
  let variants = []

  if (input.includes("cart.php")) {
    const extracted = extractProductIdFromCart(input)
    if (extracted?.length > 10) {
      hashedId = extracted
    } else {
      numericProductId = extracted
    }
    cartUrl = input
  }

  if (input.includes("/products/")) {
    numericProductId = extractNumericIdFromImage(input)
    image = input
  }

  if (input.includes("jellycat.com") && !input.includes("cart.php")) {
    productUrl = input
  }

  if (!productUrl && numericProductId) {
    const ss = await fetchSearchspring(numericProductId)
    if (ss?.url) {
      productUrl = "https://us.jellycat.com" + ss.url
      searchspringId = ss.id
    }
  }

  if (productUrl) {
    const scraped = await scrapeProductPage(productUrl)
    if (scraped) {
      numericProductId = scraped.numericProductId
      name = scraped.name
      price = scraped.price
      sku = scraped.sku
      image = scraped.image
      variants = scraped.variants
    }
  }

  if (!hashedId && numericProductId) {
    hashedId = md5(numericProductId.toString())
  }

  const hashedUrl = hashedId
    ? `https://us.jellycat.com/cart.php?action=add&product_id=${hashedId}`
    : ""

  const finalCart =
    cartUrl ||
    (numericProductId
      ? `https://us.jellycat.com/cart.php?action=add&product_id=${numericProductId}`
      : "")

  return {
    numericProductId,
    searchspringId,
    name,
    productUrl,
    finalCart,
    hashedId,
    hashedUrl,
    sku,
    variants,
    price,
    image
  }
}

app.post("/resolve", async (req, res) => {
  const { inputs } = req.body

  const results = await Promise.all(
    inputs.map(i => limit(() => resolveInput(i)))
  )

  res.json(results)
})

app.listen(process.env.PORT || 3000, () =>
  console.log("Jiggler running")
)

