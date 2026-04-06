"""ConstitutionResolver: deterministic caching (content hash), stable repeated resolve."""

from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_ENGINE = Path(__file__).resolve().parent
if str(_ENGINE) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_ENGINE))

from constitution_resolver import ConstitutionResolver  # noqa: E402


class ConstitutionResolverDeterminismTests(unittest.TestCase):
    def test_repeated_resolve_same_object_and_hash(self) -> None:
        path = _ENGINE / "constitutions.json"
        if not path.is_file():
            self.skipTest("constitutions.json missing")
        r = ConstitutionResolver(path)
        first = r.resolve("zak-default")
        for _ in range(200):
            again = r.resolve("zak-default")
            self.assertIs(again, first)
            self.assertEqual(again.policy_hash, first.policy_hash)
            self.assertEqual(again.constitution_id, first.constitution_id)

    def test_concurrent_resolve_matches(self) -> None:
        path = _ENGINE / "constitutions.json"
        if not path.is_file():
            self.skipTest("constitutions.json missing")
        r = ConstitutionResolver(path)
        baseline = r.resolve("zak-default")

        def _one() -> str:
            return r.resolve("zak-default").policy_hash

        with ThreadPoolExecutor(max_workers=32) as ex:
            hashes = list(ex.map(lambda _: _one(), range(64)))
        self.assertTrue(all(h == baseline.policy_hash for h in hashes))


if __name__ == "__main__":
    unittest.main()
