import json
import sys
from math_ops import divide
from text_ops import greeting


def main(data):
    try:
        quotient, remainder = divide(data["a"], data["b"])
        message, length = greeting(data["name"])
        return {"quotient": quotient, "remainder": remainder,
                "greeting": message, "length": length}
    except ValueError as error:
        return {"error": str(error)}


if __name__ == "__main__":
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
