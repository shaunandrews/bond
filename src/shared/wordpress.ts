export interface WordPressSite {
  id: string
  name: string
  path: string
  port: number
  url: string
  running: boolean
  phpVersion: string
  enableHttps: boolean
  adminUsername: string
  adminEmail: string
  isWpAutoUpdating: boolean
  autoStart: boolean
  customDomain?: string
  enableXdebug?: boolean
  enableDebugLog?: boolean
  enableDebugDisplay?: boolean
}

export interface WpTheme {
  name: string
  status: string
  version: string
}

export interface WpPlugin {
  name: string
  status: string
  version: string
  updateVersion: string
}

export interface WpTemplate {
  title: string
  name: string
}

export interface WpContent {
  id: number
  title: string
  slug: string
  type: 'post' | 'page'
  content: string
}

export interface WordPressSiteDetails {
  wpVersion: string
  siteTitle: string
  tagline: string
  permalinkStructure: string
  themes: WpTheme[]
  plugins: WpPlugin[]
  templates: WpTemplate[]
  postCount: number
  pageCount: number
  userCount: number
  content: WpContent[]
}
