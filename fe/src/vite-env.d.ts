/// <reference types="vite/client" />

interface CSSModuleClasses {
  [className: string]: string
}

declare module '*.css' {
  const classes: CSSModuleClasses
  export default classes
}

declare module '*.module.css' {
  const classes: CSSModuleClasses
  export default classes
}

declare module '*.scss' {
  const classes: CSSModuleClasses
  export default classes
}

declare module '*.module.scss' {
  const classes: CSSModuleClasses
  export default classes
}
