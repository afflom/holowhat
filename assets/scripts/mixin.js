export const path = new URL(import.meta.url).searchParams.get("package")

export const getNodes = () => {
  const root = document.body
  if (!root || !path) return []
  const result = []

  const findBlocks = (node) => {
    if (
      node.tagName &&
      (node.tagName.endsWith("-BLOCK") || node.tagName.endsWith("-CELL")) &&
      node?.mixins?.includes(path)
    ) {
      result.push(node)
    }
    // Traverse shadowRoot if present
    if (node.shadowRoot) {
      node.shadowRoot.querySelectorAll("*").forEach(findBlocks)
    }
    // Traverse children
    node.children && Array.from(node.children).forEach(findBlocks)
  }

  findBlocks(root)
  return result
}

export const some = (expr) => {
  if (!window.Alpine) return false
  return getNodes().some((el) => {
    const ctx = el.shadowRoot?.querySelector("[x-data]")
    return ctx ? Alpine.evaluate(ctx, expr) : false
  })
}
