"""Word Error Rate scoring for transcript quality checks.

Normalizes casing/punctuation and maps spelled-out numbers to digits (and back),
so "nine thirty" vs "9:30" style differences do not inflate the score beyond what
a human would call an error.
"""
import re

_NUM_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18",
    "nineteen": "19", "twenty": "20", "thirty": "30", "forty": "40",
    "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90",
    "hundred": "100", "percent": "%",
}


def normalize(text):
    text = text.lower()
    text = text.replace("%", " percent ")
    text = re.sub(r"[^a-z0-9\s:]", " ", text)
    text = text.replace(":", " ")
    tokens = []
    for tok in text.split():
        tokens.append(_NUM_WORDS.get(tok, tok))
    return tokens


def wer(reference, hypothesis):
    """Levenshtein distance over words. Returns (wer, substitutions, deletions, insertions, n_ref)."""
    ref = normalize(reference)
    hyp = normalize(hypothesis)
    n, m = len(ref), len(hyp)
    if n == 0:
        return (0.0 if m == 0 else 1.0), 0, 0, m, 0

    # dp[i][j] = (cost, sub, del, ins)
    dp = [[(0, 0, 0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = (i, 0, i, 0)
    for j in range(1, m + 1):
        dp[0][j] = (j, 0, 0, j)

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
                continue
            sub_c, sub_s, sub_d, sub_i = dp[i - 1][j - 1]
            del_c, del_s, del_d, del_i = dp[i - 1][j]
            ins_c, ins_s, ins_d, ins_i = dp[i][j - 1]
            best = min(
                (sub_c + 1, sub_s + 1, sub_d, sub_i),
                (del_c + 1, del_s, del_d + 1, del_i),
                (ins_c + 1, ins_s, ins_d, ins_i + 1),
                key=lambda t: t[0],
            )
            dp[i][j] = best

    cost, subs, dels, inss = dp[n][m]
    return cost / n, subs, dels, inss, n


def report(reference, hypothesis):
    rate, subs, dels, inss, n = wer(reference, hypothesis)
    return {
        "wer": round(rate, 4),
        "accuracy_pct": round((1 - rate) * 100, 2),
        "substitutions": subs,
        "deletions": dels,
        "insertions": inss,
        "reference_words": n,
        "reference_normalized": " ".join(normalize(reference)),
        "hypothesis_normalized": " ".join(normalize(hypothesis)),
    }
