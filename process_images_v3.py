from PIL import Image
import os

files = {
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\formal_gala_1783355987320.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\formal\formal_black_tie_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\formal_executive_1783355998041.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\formal\formal_executive_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\entertainment_cinema_1783356006938.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\entertainment\entertainment_cinema_v4.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\entertainment_music_1783356018016.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\entertainment\entertainment_music_v4.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\entertainment_show_1783356027930.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\entertainment\entertainment_show_v4.webp"
}

TARGET_W = 820
TARGET_H = 1024

for src, dst in files.items():
    print(f"Processing {src} -> {dst}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    img = Image.open(src)
    
    # Calculate aspect ratios
    img_ratio = img.width / img.height
    target_ratio = TARGET_W / TARGET_H
    
    if img_ratio > target_ratio:
        # Image is wider than target, crop width
        new_w = int(img.height * target_ratio)
        offset = (img.width - new_w) // 2
        img = img.crop((offset, 0, offset + new_w, img.height))
    elif img_ratio < target_ratio:
        # Image is taller than target, crop height
        new_h = int(img.width / target_ratio)
        offset = (img.height - new_h) // 2
        img = img.crop((0, offset, img.width, offset + new_h))
        
    # Resize to exact dimensions
    img = img.resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    
    # Save as webp with quality 85
    img.save(dst, 'WEBP', quality=85)
    print(f"Saved {dst}")
