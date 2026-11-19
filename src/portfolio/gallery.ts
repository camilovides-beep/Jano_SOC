/** Un elemento de la galeria en pantalla: una foto del portafolio (miniatura y tamaño completo). */
export interface GalleryItem { thumb?: string; full?: string; label: string; credit?: string; link?: string; }
/** Galeria de la sesion: lo que se esta mostrando al lado del avatar y cual esta seleccionada (va de fondo). */
export interface GalleryState { title: string; kind: 'portafolio' | ''; items: GalleryItem[]; index: number; }
export const newGallery = (): GalleryState => ({ title: '', kind: '', items: [], index: 0 });
