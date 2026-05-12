// Web-bundle entry point. Loads the Electron preload (which Vite has aliased
// to our browser shims, populating `window.api` and `window.electron`), then
// the actual React renderer.
import './process-shim'
import '../preload/index'
import '../renderer/src/main'
