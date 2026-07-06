import sys
from PIL import Image, ImageStat

files = [
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805369.jpg",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805374.jpg",
    r"C:\Users\Minar\.gemini\antigravity\brain\6436af3d-779c-44e8-8b0b-1fed3a276ace\media__1783362805449.jpg"
]

for f in files:
    img = Image.open(f)
    stat = ImageStat.Stat(img)
    print(f"File: {f}")
    print(f"Size: {img.size}")
    print(f"Average Color (RGB): {stat.mean}")
