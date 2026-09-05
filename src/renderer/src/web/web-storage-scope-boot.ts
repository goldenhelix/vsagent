// Why (VSAgent fork): must run before ANY module reads localStorage — this is
// the first import of the web entry, so every `orca*` key (upstream ones
// included) is scoped from the very first access.
import { installScopedWebStorage } from './web-storage-scope-install'

installScopedWebStorage()
