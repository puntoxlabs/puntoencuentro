from PIL import Image
import os

files = {
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\learning_course_1783357758520.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\learning\learning_course_v1.webp",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\learning_talk_1783357768020.png": r"c:\Users\Minar\Documents\Proyectos\PuntoEncuentro\public\invitation-templates\learning\learning_talk_v1.webp"
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
