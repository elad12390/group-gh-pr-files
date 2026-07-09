const api = typeof browser !== 'undefined' ? browser : chrome
const statusEl = document.getElementById('status')

document.getElementById('toggle').addEventListener('click', async () => {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true })
    const tab = tabs && tabs[0]
    if (!tab) throw new Error('no tab')
    await api.tabs.sendMessage(tab.id, { type: 'gpf-toggle' })
    window.close()
  } catch (_) {
    statusEl.textContent = 'Open a GitHub pull request page first, then reload it.'
  }
})
