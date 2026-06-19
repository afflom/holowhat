function toDashCase(str) {
  return str.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
}

function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase())
}

export default class AlpineBlock extends HTMLElement {
  static tagName = ""
  static pkg = ""

  static reloadAllBlocks(root = document, mixin) {
    const elements = root.querySelectorAll("*")
    elements.forEach((el) => {
      if (
        typeof el.reloadFromTemplate === "function" &&
        (!mixin
          ? el.tagName.toLowerCase() === this.tagName.toLowerCase()
          : Array.isArray(el.mixins) && el.mixins.includes(mixin))
      ) {
        el.reloadFromTemplate()
      }
    })
    // Recursively search shadowRoots of elements ending with -block
    elements.forEach((el) => {
      if (
        el.tagName &&
        (el.tagName.toLowerCase().endsWith("-block") ||
          el.tagName.toLowerCase().endsWith("-cell")) &&
        el.shadowRoot
      ) {
        this.reloadAllBlocks.call(this, el.shadowRoot, mixin)
      }
    })
  }

  mixins = []

  constructor() {
    super()
    this.pkg = this.constructor.pkg
    this.Alpine = window.Alpine ? window.Alpine : false

    this.attachShadow({ mode: "open" })

    this.observer = new MutationObserver((mutationRecords) => {
      mutationRecords.forEach((record) => {
        const name = record.attributeName

        if (name.startsWith("@") || name.startsWith(":")) return

        const value = this.getAttribute(record.attributeName)
        const props =
          this.rootContent && this.Alpine.$data(this.rootContent).props

        if (!props) return

        if (props[toCamelCase(name)] === value) return

        this.Alpine.nextTick(() => {
          props[toCamelCase(name)] = value
        })
      })
    }).observe(this, { attributes: true })

    this.loadModule()
  }

  async loadModule() {
    // Instead of parsing, expect the template to already be at #${this.pkg}/${this.constructor.tagName}
    const doc = document.querySelector(
      `#${this.pkg}-${this.constructor.tagName}`,
    )
    if (!doc) {
      throw new Error(
        `Template element #${this.pkg}/${this.constructor.tagName} not found in the document.`,
      )
    }

    const scripts = doc.content.querySelectorAll("script")
    const styles = doc.content.querySelectorAll("style")

    if (scripts.length !== 1) {
      throw new Error("SFC must contain exactly one <script>.")
    }

    this.rootNodes = Array.from(doc.content.childNodes).filter(
      (node) =>
        !(
          node.nodeType === Node.ELEMENT_NODE &&
          (node.tagName === "SCRIPT" ||
            node.tagName === "STYLE" ||
            node.tagName === "TEMPLATE")
        ) &&
        !(node.nodeType === Node.TEXT_NODE && node.textContent.trim() === ""),
    )

    if (this.rootNodes.length !== 1) {
      throw new Error(
        "SFC must contain exactly one root node (excluding <script> and <style>).",
      )
    }

    styles.forEach((style) => {
      this.shadowRoot.appendChild(style.cloneNode(true))
    })

    const script = scripts[0]
    try {
      const blob = new Blob([script.textContent], {
        type: "text/javascript",
      })
      const url = URL.createObjectURL(blob)
      const module = await import(url)
      URL.revokeObjectURL(url)

      const mergedExport = module.default || {}
      const mixinInits = []
      const mixinDestroys = []
      const mainKeys = new Set(Object.keys(mergedExport))
      const templates = []

      if (Array.isArray(module.default?.mixins)) {
        this.mixins = module.default?.mixins
        for (const mixinSFC of module.default.mixins) {
          const [pkg, tag] = mixinSFC.split("/")

          const mixinDoc = document.querySelector(`#${pkg.slice(1)}-${tag}`)
          if (!doc) {
            throw new Error(
              `Template element #${pkg.slice(
                1,
              )}-${tag} not found in the document.`,
            )
          }

          mixinDoc.content.querySelectorAll("template").forEach((tpl) => {
            templates.push(tpl)
          })
          mixinDoc.content.querySelectorAll("style").forEach((style) => {
            this.shadowRoot.appendChild(style.cloneNode(true))
          })

          const allMixinScripts = mixinDoc.querySelectorAll("script")
          Array.from(allMixinScripts)
            .filter((script) => script.type !== "module")
            .forEach((s) => {
              this.shadowRoot.prepend(s.cloneNode(true))
            })
          const mixinScript = mixinDoc.content.querySelector(
            'script[type="module"]',
          )
          if (mixinScript) {
            const mixinBlob = new Blob([mixinScript.textContent], {
              type: "text/javascript",
            })
            const mixinUrl = URL.createObjectURL(mixinBlob)
            try {
              const mixinModule = await import(mixinUrl)
              const mixinExport = mixinModule.default || {}
              for (const key of Object.keys(mixinExport)) {
                if (key === "init") {
                  mixinInits.push(mixinExport.init)
                } else if (key === "destroy") {
                  mixinDestroys.push(mixinExport.destroy)
                } else if (key === "mixins") {
                  mergedExport.mixins.push(...mixinExport.mixins)
                } else if (mainKeys.has(key)) {
                  /* throw new Error(
                    `Mixin is attempting to override already defined key: ${key}`
                  ); */
                } else {
                  mergedExport[key] = mixinExport[key]
                  mainKeys.add(key)
                }
              }
            } finally {
              URL.revokeObjectURL(mixinUrl)
            }
          }
        }
      }

      if (typeof mergedExport.init === "function" || mixinInits.length > 0) {
        const mainInit = mergedExport.init
        mergedExport.init = function (...args) {
          for (const fn of mixinInits) {
            if (typeof fn === "function") fn.apply(this, args)
          }
          if (typeof mainInit === "function") mainInit.apply(this, args)
        }
      }
      if (
        typeof mergedExport.destroy === "function" ||
        mixinDestroys.length > 0
      ) {
        const mainDestroy = mergedExport.destroy
        mergedExport.destroy = function (...args) {
          for (const fn of mixinDestroys) {
            if (typeof fn === "function") fn.apply(this, args)
          }
          if (typeof mainDestroy === "function") mainDestroy.apply(this, args)
        }
      }

      this.rootContent = this.rootNodes[0].cloneNode(true)

      // Move <template> nodes that are not already inside the root node into the root node
      doc.querySelectorAll("template").forEach((tpl) => {
        if (!this.rootNodes[0].contains(tpl)) {
          this.rootContent.appendChild(tpl.cloneNode(true))
        }
      })

      templates.forEach((tpl) => {
        this.rootContent.appendChild(tpl.cloneNode(true))
      })

      this.rootContent.setAttribute("x-data", "block")
      this.shadowRoot.appendChild(this.rootContent)

      const self = this
      mergedExport.props = new Proxy(
        {},
        {
          set(target, prop, value) {
            target[prop] = value
            if (!prop.startsWith("@") && !prop.startsWith(":")) {
              self.setAttribute(toDashCase(prop), value)
            }
            return true
          },
          get(target, prop) {
            return target[prop]
          },
        },
      )
      Array.from(this.attributes).forEach((attr) => {
        if (!attr.name.startsWith("@") && !attr.name.startsWith(":")) {
          mergedExport.props[toCamelCase(attr.name)] = attr.value
        }
      })
      this.props = mergedExport.props

      if (Alpine) {
        Alpine.data("block", () => mergedExport)
        Alpine.initTree(this.shadowRoot)
      }
    } catch (e) {
      console.error(
        `Error importing SFC module ${this.constructor.tagName}:`,
        e,
      )
    }
  }

  reloadFromTemplate() {
    if (this.shadowRoot) {
      this.shadowRoot.replaceChildren()
    }

    document
      .querySelectorAll(`[data-block="${this.tagName.toLowerCase()}"]`)
      .forEach((el) => el.remove())

    this.loadModule()
  }

  needsSync(docEntry) {
    if (docEntry.tagName !== this.tagName.toLowerCase()) return true

    if (docEntry.parentId && docEntry.parentId !== this.parentElement.id)
      return true

    const domProps = new Set()
    for (const attr of this.attributes) {
      if (
        attr.name === "id" ||
        attr.name.startsWith(":") ||
        attr.name.startsWith("@")
      )
        continue
      domProps.add(attr.name)
      if (docEntry.props[attr.name] !== attr.value) return true
    }

    for (const key of Object.keys(docEntry.props)) {
      if (!domProps.has(key)) return true
    }

    return false
  }

  syncToDoc(action) {
    handle.change((doc) => {
      const idx = doc.world.findIndex((n) => n.id === this.id)

      if (action === "remove") {
        if (idx !== -1) {
          const toDelete = new Set([this.id])
          for (const n of doc.world) {
            if (n.parentId && toDelete.has(n.parentId)) {
              toDelete.add(n.id)
            }
          }
          for (let i = doc.world.length - 1; i >= 0; i--) {
            if (toDelete.has(doc.world[i].id)) {
              doc.world.splice(i, 1)
            }
          }
        }
      } else {
        // Add or update
        let i = idx
        if (i === -1) {
          doc.world.push({
            id: this.id,
            tagName: this.tagName.toLowerCase(),
            props: {},
          })
          i = doc.world.length - 1
        }

        const entry = doc.world[i]
        entry.tagName = this.tagName.toLowerCase()

        // Sync props
        const seen = new Set()
        for (const attr of this.attributes) {
          if (
            attr.name === "id" ||
            attr.name.startsWith(":") ||
            attr.name.startsWith("@")
          )
            continue
          if (entry.props[attr.name] !== attr.value) {
            entry.props[attr.name] = attr.value
          }
          seen.add(attr.name)
        }

        // Only on removeAttribute??
        /* for (const key of Object.keys(entry.props)) {
          if (!seen.has(key)) {
            console.log("delete", key);
            delete entry.props[key];
          }
        } */

        // Set parent
        const parent = this.parentElement
        const pid =
          this.tagName === "WORLD-BLOCK"
            ? null
            : parent?.constructor?.name === "AlpineBlockSFC" &&
                parent.tagName !== "WORLD-BLOCK"
              ? (parent.id ||= "pg" + crypto.randomUUID().replace(/-/g, ""))
              : null

        if (pid) entry.parentId = pid
        else delete entry.parentId
      }
    })
  }

  setAttribute(name, value, syncing = false) {
    super.setAttribute(name, value)

    if (
      !syncing &&
      name !== "id" &&
      !name.startsWith(":") &&
      !name.startsWith("@")
    ) {
      const entry = handle.doc().world?.find((n) => n.id === this.id)
      if (entry && this.needsSync(entry)) {
        this.syncToDoc("update")
      }
    }
  }

  removeAttribute(name, syncing = false) {
    super.removeAttribute(name)

    if (
      !syncing &&
      name !== "id" &&
      !name.startsWith(":") &&
      !name.startsWith("@")
    ) {
      const entry = handle.doc().world.find((n) => n.id === this.id)
      if (entry && this.needsSync(entry)) {
        this.syncToDoc("update")
      }
    }
  }

  connectedCallback() {
    if (this.constructor.tagName === "world-block") return
    if (!this.closest("world-block")) return
    if (this.getRootNode() instanceof ShadowRoot) return

    this.id ||= "pg" + crypto.randomUUID().replace(/-/g, "")

    const existing = handle.doc().world.find((n) => n.id === this.id)

    if (!existing) {
      this.syncToDoc("add")
    } else {
      if (this.needsSync(existing)) {
        this.syncToDoc("update")
      }
    }
  }

  connectedMoveCallback() {}

  attributeChangedCallback() {}

  disconnectedCallback() {
    this.observer?.disconnect()

    const exists = handle.doc().world.find((n) => n.id === this.id)

    if (exists) {
      this.syncToDoc("remove")
    }
  }
}
