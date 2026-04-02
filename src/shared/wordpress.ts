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
  adminPassword: string
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
  parent: number
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

// --- Site Map ---

export interface WpSiteMapNode {
  id: number
  title: string
  slug: string
  type: 'page' | 'post'
  parent: number
  url: string
  children: WpSiteMapNode[]
}

export interface WpSiteMap {
  pages: WpSiteMapNode[]
  posts: WpSiteMapNode[]
  homePageId: number | null
}

// --- Theme JSON ---

export interface WpThemeJsonColor {
  slug: string
  name: string
  color: string
}

export interface WpThemeJsonFontFamily {
  slug: string
  name: string
  fontFamily: string
}

export interface WpThemeJsonFontSize {
  slug: string
  name: string
  size: string
}

export interface WpThemeJsonSpacing {
  slug: string
  name: string
  size: string
}

export interface WpThemeJson {
  colors: WpThemeJsonColor[]
  fontFamilies: WpThemeJsonFontFamily[]
  fontSizes: WpThemeJsonFontSize[]
  spacingSizes: WpThemeJsonSpacing[]
  contentWidth?: string
  wideWidth?: string
}
