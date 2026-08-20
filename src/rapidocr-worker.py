# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "onnxruntime==1.29.0",
#   "rapidocr==3.9.2",
# ]
# ///
import json
import sys

from rapidocr import ModelType, RapidOCR


def write_message(message):
    print(json.dumps(message, ensure_ascii=False, separators=(",", ":")), flush=True)


def fragment_from_result(box, text, score):
    left = float(min(point[0] for point in box))
    right = float(max(point[0] for point in box))
    top = float(min(point[1] for point in box))
    bottom = float(max(point[1] for point in box))
    return {
        "left": left,
        "right": right,
        "top": top,
        "bottom": bottom,
        "center_y": (top + bottom) / 2,
        "text": text,
        "confidence": float(score),
    }


def vertically_overlaps(group, fragment):
    overlap = min(group["bottom"], fragment["bottom"]) - max(group["top"], fragment["top"])
    shortest_height = min(
        group["bottom"] - group["top"],
        fragment["bottom"] - fragment["top"],
    )
    return overlap > 0 and overlap >= shortest_height * 0.5


def merge_fragments(fragments):
    groups = []
    for fragment in sorted(fragments, key=lambda item: item["center_y"]):
        group = groups[-1] if groups and vertically_overlaps(groups[-1], fragment) else None
        if group is None:
            groups.append({
                "top": fragment["top"],
                "bottom": fragment["bottom"],
                "fragments": [fragment],
            })
            continue

        group["top"] = min(group["top"], fragment["top"])
        group["bottom"] = max(group["bottom"], fragment["bottom"])
        group["fragments"].append(fragment)

    items = []
    for group in groups:
        ordered = sorted(group["fragments"], key=lambda item: item["left"])
        left = min(item["left"] for item in ordered)
        right = max(item["right"] for item in ordered)
        top = min(item["top"] for item in ordered)
        bottom = max(item["bottom"] for item in ordered)
        total_characters = sum(max(1, len(item["text"])) for item in ordered)
        confidence = sum(
            item["confidence"] * max(1, len(item["text"])) for item in ordered
        ) / total_characters
        items.append({
            "text": " ".join(item["text"] for item in ordered),
            "confidence": confidence,
            "bounds": {
                "x": left,
                "y": top,
                "width": right - left,
                "height": bottom - top,
            },
        })
    return items


def recognize(engine, image_path):
    result = engine(image_path, use_det=True, use_cls=False, use_rec=True)
    boxes = result.boxes if result.boxes is not None else ()
    texts = result.txts if result.txts is not None else ()
    scores = result.scores if result.scores is not None else ()
    fragments = [
        fragment_from_result(box, text, score)
        for box, text, score in zip(boxes, texts, scores)
    ]
    return merge_fragments(fragments)


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    engine = RapidOCR(params={
        "Global.log_level": "error",
        "Global.use_cls": False,
        "Det.model_type": ModelType.SMALL,
        "Rec.model_type": ModelType.SMALL,
    })
    write_message({"type": "ready", "backend": "rapidocr", "model": "small"})

    for serialized in sys.stdin:
        request_id = None
        try:
            request = json.loads(serialized)
            request_id = request["id"]
            image_path = request["imagePath"]
            write_message({"id": request_id, "items": recognize(engine, image_path)})
        except Exception as error:
            write_message({
                "id": request_id,
                "error": {
                    "code": "OCR_RAPIDOCR_FAILED",
                    "message": str(error),
                },
            })


if __name__ == "__main__":
    main()
