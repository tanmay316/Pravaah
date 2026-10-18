"""HTTP hardening: per-IP rate limits, body size limit and security headers."""

import sys
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "api"))
from app import security  # noqa: E402


def make_app():
    app = FastAPI()
    app.add_middleware(BaseHTTPMiddleware, dispatch=security.security_middleware)

    @app.post("/api/me/coupons/redeem")
    async def redeem():
        return {"ok": True}

    @app.post("/api/echo")
    async def echo():
        return {"ok": True}

    return app


class SecurityMiddlewareTests(unittest.TestCase):
    def setUp(self):
        security._hits.clear()
        self.client = TestClient(make_app())

    def test_sensitive_route_is_rate_limited_per_ip(self):
        headers = {"X-Forwarded-For": "203.0.113.7"}
        codes = [self.client.post("/api/me/coupons/redeem", headers=headers).status_code for _ in range(16)]
        self.assertEqual(codes[:15], [200] * 15)
        self.assertEqual(codes[15], 429)
        blocked = self.client.post("/api/me/coupons/redeem", headers=headers)
        self.assertIn("Retry-After", blocked.headers)
        # A different client is unaffected.
        other = self.client.post("/api/me/coupons/redeem", headers={"X-Forwarded-For": "198.51.100.2"})
        self.assertEqual(other.status_code, 200)

    def test_oversized_bodies_are_rejected(self):
        response = self.client.post("/api/echo", content=b"x" * (security.MAX_BODY_BYTES + 1),
                                    headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)

    def test_security_headers_are_set(self):
        response = self.client.post("/api/echo")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertIn("max-age", response.headers["Strict-Transport-Security"])


if __name__ == "__main__":
    unittest.main()
