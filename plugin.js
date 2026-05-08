// plugin.js — 在 Penpot 環境中執行，可存取 penpot 物件

try {
  penpot.ui.open('Penpot → Claude', '?v=1', { width: 400, height: 540 })
} catch (e) {
  console.error('[penpot-claude] ui.open failed:', e)
}

// 安全轉陣列（fills/strokes 有時不是 Array）
function toArray(val) {
  if (!val) return []
  if (Array.isArray(val)) return val
  try { return Array.from(val) } catch (_) { return [] }
}

// 建立 colorId → { name, color, opacity } 對照表（local + connected library）
function buildColorMap() {
  const map = {}
  function addColors(colors) {
    toArray(colors).forEach((c) => {
      if (!c.id) return
      map[c.id] = {
        name:     c.name     ?? null,
        color:    c.color    ?? null,
        opacity:  c.opacity  ?? 1,
        gradient: c.gradient ?? null,
      }
    })
  }
  try { addColors(penpot.library?.local?.colors) } catch (_) {}
  try {
    toArray(penpot.library?.connected).forEach((lib) => {
      try { addColors(lib.colors) } catch (_) {}
    })
  } catch (_) {}
  return map
}

// linear gradient → CSS 角度（0deg=朝上, 90deg=朝右, 180deg=朝下）
function gradientAngle(g) {
  if (!g) return null
  const sx = g.startX ?? 0.5, sy = g.startY ?? 0
  const ex = g.endX   ?? 0.5, ey = g.endY   ?? 1
  const angle = Math.round(Math.atan2(ex - sx, -(ey - sy)) * 180 / Math.PI)
  return ((angle % 360) + 360) % 360
}

// solid hex（含 alpha）
function solidHex(color, opacity) {
  if (!color) return null
  const op = opacity ?? 1
  if (op < 1) {
    const alpha = Math.round(op * 255).toString(16).padStart(2, '0')
    return `${color}${alpha}`
  }
  return color
}

// fill → 顏色值，包含 library 名稱
function fillToColor(fill, colorMap) {
  if (!fill) return null
  const lib  = colorMap[fill.fillColorRefId] ?? null
  const type = fill.fillType ?? 'solid'

  if (type === 'solid' || type === 'none') {
    // fill 本身或 library color 帶 gradient（solid fill 也可能指向 gradient library color）
    const gradient = fill.fillColorGradient ?? fill.gradient ?? lib?.gradient ?? null
    if (gradient) {
      const gradType = gradient.type ?? 'linear'
      const entry = { type: gradType }
      if (lib?.name) entry.name = lib.name
      if (gradType === 'linear') {
        const angle = gradientAngle(gradient)
        if (angle != null) entry.angle = angle
      }
      entry.stops = toArray(gradient.stops).map((s) => ({
        color: solidHex(s.color, s.opacity),
        offset: Math.round((s.offset ?? 0) * 100) / 100,
      }))
      return entry
    }
    const rawHex  = fill.fillColor  || lib?.color  || null
    const opacity = fill.fillOpacity ?? lib?.opacity ?? 1
    const hex = rawHex ? solidHex(rawHex, opacity) : null
    if (hex && lib?.name) return { name: lib.name, color: hex }
    if (lib?.name)        return { name: lib.name }
    if (hex)              return hex
    return null
  }
  if (type === 'linear' || type === 'radial' || type === 'gradient') {
    // fill 自身的 gradient → fallback library gradient
    const gradient = fill.fillColorGradient ?? fill.gradient ?? lib?.gradient ?? null
    const gradType = gradient?.type ?? (type === 'gradient' ? 'linear' : type)
    const entry = { type: gradType }
    if (lib?.name) entry.name = lib.name
    if (gradient) {
      if (gradType === 'linear') {
        const angle = gradientAngle(gradient)
        if (angle != null) entry.angle = angle
      }
      entry.stops = toArray(gradient.stops).map((s) => ({
        color: solidHex(s.color, s.opacity),
        offset: Math.round((s.offset ?? 0) * 100) / 100,
      }))
    }
    return entry
  }
  if (type === 'image') return { type: 'image' }
  // catch-all：未知 type 至少輸出 type 與已知資訊，不靜默丟棄
  const hex = fill.fillColor ? solidHex(fill.fillColor, fill.fillOpacity) : null
  if (hex && lib?.name) return { type, name: lib.name, color: hex }
  if (lib?.name) return { type, name: lib.name }
  if (hex)       return { type, color: hex }
  return { type }
}

// 過濾無視覺意義的 Penpot 基礎設施節點
function shouldSkip(shape) {
  // if (shape.type === 'svg-raw') return true
  if (
    shape.name === 'base-background' &&
    shape.type === 'rectangle' &&
    toArray(shape.fills).length === 0 &&
    toArray(shape.strokes).length === 0
  ) return true
  return false
}

// 從 content 樹取字型樣式（fallback）
function textStyleFromContent(content) {
  const style = {}
  function walk(node) {
    if (!node) return
    if (node.textAlign      && style.textAlign      == null) style.textAlign      = node.textAlign
    if (node.lineHeight     && style.lineHeight     == null) style.lineHeight     = node.lineHeight
    if (node.fontSize       && style.fontSize       == null) style.fontSize       = Math.round(Number(node.fontSize))
    if (node.fontWeight     && style.fontWeight     == null) style.fontWeight     = String(node.fontWeight)
    if (node.fontFamily     && style.fontFamily     == null) style.fontFamily     = node.fontFamily
    if (node.letterSpacing != null && style.letterSpacing == null) style.letterSpacing = node.letterSpacing
    toArray(node.children).forEach(walk)
  }
  walk(content)
  return style
}

// 遞迴萃取 shape 資料
// parentX/parentY 為父層絕對座標，用來輸出相對位置
function extractShape(shape, depth, colorMap, parentX, parentY) {
  // 元件參考（名稱含 " / "）視為圖片佔位，不展開內部結構
  if (shape.name.includes(' / ')) {
    const absX = shape.x != null ? Math.round(shape.x) : parentX
    const absY = shape.y != null ? Math.round(shape.y) : parentY
    const node = { name: shape.name, type: 'image' }
    if (shape.width  != null) node.w = Math.round(shape.width)
    if (shape.height != null) node.h = Math.round(shape.height)
    if (shape.x      != null) node.x = absX - parentX
    if (shape.y      != null) node.y = absY - parentY
    if (shape.opacity != null && shape.opacity < 0.999)
      node.opacity = Math.round(shape.opacity * 100) / 100
    if (shape.borderRadius != null && shape.borderRadius > 0)
      node.radius = Math.round(shape.borderRadius)
    const fillList = toArray(shape.fills)
    if (fillList.length > 0) {
      const colors = fillList.map((f) => fillToColor(f, colorMap)).filter(Boolean)
      if (colors.length > 0) node.fills = colors
    }
    const strokeList = toArray(shape.strokes)
    if (strokeList.length > 0) {
      const strokes = strokeList.map((s) => {
        const lib    = colorMap[s.strokeColorRefId] ?? null
        const rawHex = s.strokeColor || lib?.color  || null
        const hex    = rawHex ? solidHex(rawHex, s.strokeOpacity ?? lib?.opacity) : null
        if (!hex && !lib?.name) return null
        const entry = (hex && lib?.name) ? { name: lib.name, color: hex }
                    : lib?.name          ? { name: lib.name }
                    : { color: hex }
        if (s.strokeWidth != null) entry.width = Math.round(s.strokeWidth)
        if (s.strokeType)          entry.strokeType = s.strokeType
        return entry
      }).filter(Boolean)
      if (strokes.length > 0) node.strokes = strokes
    }
    if (depth < 5 && shape.children && shape.children.length > 0) {
      const children = toArray(shape.children)
        .filter((child) => !shouldSkip(child))
        .map((child) => extractShape(child, depth + 1, colorMap, absX, absY))
      if (children.length > 0) node.children = children
    }
    return node
  }

  const result = { name: shape.name }
  if (shape.type !== 'board') result.type = shape.type

  const absX = shape.x != null ? Math.round(shape.x) : parentX
  const absY = shape.y != null ? Math.round(shape.y) : parentY

  if (shape.width  != null) result.w = Math.round(shape.width)
  if (shape.height != null) result.h = Math.round(shape.height)
  if (shape.x      != null) result.x = absX - parentX
  if (shape.y      != null) result.y = absY - parentY

  // Opacity（非完全不透明才輸出）
  if (shape.opacity != null && shape.opacity < 0.999) {
    result.opacity = Math.round(shape.opacity * 100) / 100
  }

  // Auto layout (flex)
  if (shape.layoutFlexDir) {
    result.layout = { type: 'flex', direction: shape.layoutFlexDir }
    const gap = shape.layoutGap
    if (gap != null) {
      result.layout.gap = typeof gap === 'object'
        ? { row: Math.round(gap.rowGap ?? gap.row ?? 0), col: Math.round(gap.columnGap ?? gap.col ?? 0) }
        : Math.round(gap)
    }
    if (shape.layoutAlignItems)     result.layout.align   = shape.layoutAlignItems
    if (shape.layoutJustifyContent) result.layout.justify = shape.layoutJustifyContent
    const pad = shape.layoutPadding
    if (pad) {
      result.layout.padding = {
        t: Math.round(pad.top    ?? 0),
        r: Math.round(pad.right  ?? 0),
        b: Math.round(pad.bottom ?? 0),
        l: Math.round(pad.left   ?? 0),
      }
    }
  }

  // 填色
  const fillList = toArray(shape.fills)
  if (fillList.length > 0) {
    const colors = fillList.map((f) => fillToColor(f, colorMap)).filter(Boolean)
    if (colors.length > 0) result.fills = colors
  }

  // Stroke
  const strokeList = toArray(shape.strokes)
  if (strokeList.length > 0) {
    const strokes = strokeList.map((s) => {
      const lib    = colorMap[s.strokeColorRefId] ?? null
      const rawHex = s.strokeColor || lib?.color  || null
      const hex    = rawHex ? solidHex(rawHex, s.strokeOpacity ?? lib?.opacity) : null
      if (!hex && !lib?.name) return null
      const entry = (hex && lib?.name) ? { name: lib.name, color: hex }
                  : lib?.name          ? { name: lib.name }
                  : { color: hex }
      if (s.strokeWidth != null) entry.width = Math.round(s.strokeWidth)
      if (s.strokeType)          entry.strokeType = s.strokeType
      return entry
    }).filter(Boolean)
    if (strokes.length > 0) result.strokes = strokes
  }

  // 圓角
  if (shape.borderRadius != null && shape.borderRadius > 0) {
    result.radius = Math.round(shape.borderRadius)
  }

  // 文字
  if (shape.type === 'text') {
    if (shape.characters) result.text = shape.characters

    // 字型樣式：優先 shape 直接屬性（uniform text），再 fallback content 樹
    const font = {}
    if (shape.fontSize      != null) font.fontSize      = Math.round(Number(shape.fontSize))
    if (shape.fontWeight    != null) font.fontWeight     = String(shape.fontWeight)
    if (shape.fontFamily    != null) font.fontFamily     = shape.fontFamily
    if (shape.textAlign     != null) font.textAlign      = shape.textAlign
    if (shape.lineHeight    != null) font.lineHeight     = shape.lineHeight
    if (shape.letterSpacing != null) font.letterSpacing  = shape.letterSpacing
    if (Object.keys(font).length === 0) Object.assign(font, textStyleFromContent(shape.content))
    if (Object.keys(font).length > 0) result.font = font

    // 文字顏色（從 content 樹萃取，去重）
    const textColors = []
    const seen = new Set()
    function addFill(f) {
      const c = fillToColor(f, colorMap)
      if (!c) return
      const key = typeof c === 'string' ? c : JSON.stringify(c)
      if (!seen.has(key)) { seen.add(key); textColors.push(c) }
    }
    function walkContent(node) {
      if (!node) return
      toArray(node.fills).forEach(addFill)
      toArray(node.children).forEach(walkContent)
    }
    if (shape.content) walkContent(shape.content)
    if (textColors.length === 0) fillList.forEach(addFill)
    if (textColors.length > 0) result.textColors = textColors
  }

  // 子元素（最多 5 層，過濾無視覺意義節點）
  if (depth < 5 && shape.children && shape.children.length > 0) {
    const children = toArray(shape.children)
      .filter((child) => !shouldSkip(child))
      .map((child) => extractShape(child, depth + 1, colorMap, absX, absY))
    if (children.length > 0) result.children = children
  }

  return result
}

penpot.ui.onMessage((msg) => {
  if (msg.type === 'export') {
    try {
      const page = penpot.currentPage
      if (!page) {
        penpot.ui.sendMessage({ type: 'error', message: '無法取得當前頁面，請確認已開啟檔案' })
        return
      }

      const colorMap = buildColorMap()
      const topShapes = toArray(page.root?.children)
      const frames = topShapes.filter((s) => s.type === 'board' && !s.name.includes('備註'))

      const data = {
        page: page.name,
        exportedAt: new Date().toISOString(),
        frameCount: frames.length,
        frames: frames.map((f) => {
          const fx = Math.round(f.x ?? 0)
          const fy = Math.round(f.y ?? 0)
          return extractShape(f, 0, colorMap, fx, fy)
        }),
      }

      penpot.ui.sendMessage({ type: 'result', data })
    } catch (err) {
      penpot.ui.sendMessage({ type: 'error', message: String(err) })
    }
  }
})
