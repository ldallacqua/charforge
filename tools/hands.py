"""hands.py <picture> [--conf 0.35] - the hand boxes for the local renders' hand pass (src/render/comfyui.ts).

Uses ADetailer's hand model (Bingsu/adetailer on Hugging Face, hand_yolov8n.pt, ~6 MB) with ultralytics:
    tools/.venv/bin/pip install ultralytics "opencv-python==4.11.0.86"
    curl -L -o tools/models/hand_yolov8n.pt https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8n.pt
The model is not in git. Prints {"hands": [[x0, y0, x1, y1, confidence], ...]}, most confident first, or
{"hands": [], "error": "..."} when the detector is not installed (the hand pass is then skipped).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('picture')
    p.add_argument('--conf', type=float, default=0.35)
    p.add_argument('--model', default=os.path.join(HERE, 'models', 'hand_yolov8n.pt'))
    args = p.parse_args()
    if not os.path.exists(args.model):
        print(json.dumps({'hands': [], 'error': f'no hand model at {args.model}'}))
        return
    try:
        from ultralytics import YOLO
    except ImportError:
        print(json.dumps({'hands': [], 'error': 'ultralytics is not installed'}))
        return
    result = YOLO(args.model).predict(args.picture, conf=args.conf, verbose=False)[0]
    hands = [[round(float(v), 1) for v in b.xyxy[0].tolist()] + [round(float(b.conf[0]), 3)] for b in result.boxes]
    print(json.dumps({'hands': sorted(hands, key=lambda h: -h[4])}))


if __name__ == '__main__':
    main()
