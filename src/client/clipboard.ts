/**
 * Putting text on the clipboard from a page.
 *
 * `navigator.clipboard` needs a secure context and a user gesture; DSH serves
 * the page from a loopback address, which qualifies, but a failed or missing
 * API would otherwise leave a button that silently does nothing. So there is
 * a fallback: a hidden textarea and the old copy command, which still works
 * inside a click handler.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // permission denied or an insecure context: try the old way
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
