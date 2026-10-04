export async function compressImage(file, maxDim = 512, maxBytes = 150 * 1024) {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  let q = 0.85
  let blob
  do {
    blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))
    q -= 0.1
  } while (blob && blob.size > maxBytes && q > 0.3)
  return blob
}
