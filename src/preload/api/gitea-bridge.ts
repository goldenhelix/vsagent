import { giteaApi } from '../gitea'
import type { PreloadApi } from '../api-types'

export const giteaApiBridge = giteaApi satisfies PreloadApi['gitea']
