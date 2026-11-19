import type { Brand } from './api';

/** The organisation's logo and name, as set in the setup wizard; the app's own name until then. */
export function BrandMark({ brand, className = '' }: { brand: Brand; className?: string }) {
  return <span className={`wordmark brandmark ${className}`}>
    {brand.logo && <img src={brand.logo} alt="" />}
    <span>{brand.name}</span>
  </span>;
}

/** Reads a picked file as a data: URL for the server, refusing anything but a small PNG, JPEG or WebP. */
export function readLogoFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.reject(new Error('Use a PNG, JPEG or WebP picture for the logo.'));
  if (file.size > 512 * 1024) return Promise.reject(new Error('That picture is over 512 KB. Use a smaller one.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That picture could not be read.'));
    reader.readAsDataURL(file);
  });
}
