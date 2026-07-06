from PIL import Image
import os

files = {
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\formal_gala_1783352645008.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\formal\formal_black_tie_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\formal_ivory_1783352653134.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\formal\formal_ivory_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\formal_executive_1783352662338.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\formal\formal_executive_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\romantic_rose_1783352672595.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\romantic\romantic_rose_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\romantic_warm_light_1783352682796.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\romantic\romantic_rainbow_v2.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\romantic_gold_1783352693245.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\romantic\romantic_gold_v2.webp"
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
