/**
 * Downscales and re-encodes an image file into a JPEG Blob under a byte
 * budget, entirely in the browser — so avatar uploads (see ProfilePanel.jsx)
 * stay small on a free-tier Supabase Storage plan without asking the user
 * to resize anything themselves.
 *
 * Every avatar ends up as JPEG at a fixed path (`<folder>/avatar.jpg`),
 * which is also what lets uploads use `upsert: true` and never leave an
 * old file behind when someone changes their picture.
 */
export async function compressImageToJpeg(
  file,
  { maxDimension = 150, maxBytes = 100 * 1024, startQuality = 0.85, minQuality = 0.4 } = {}
) {
  const bitmap = await loadBitmap(file)

  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  let quality = startQuality
  let blob = await canvasToJpegBlob(canvas, quality)
  while (blob.size > maxBytes && quality > minQuality) {
    quality = Math.max(minQuality, quality - 0.15)
    blob = await canvasToJpegBlob(canvas, quality)
  }

  if (blob.size > maxBytes) {
    throw new Error('Image is too large even after compression — please choose a simpler image.')
  }

  return blob
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> based path below (some browsers can't
      // decode every format via createImageBitmap).
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('Could not read that image file.'))
      img.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not process that image.'))),
      'image/jpeg',
      quality
    )
  })
}
