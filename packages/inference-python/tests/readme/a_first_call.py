from semiont_inference.factory import create_inference_client


async def ask(base_url: str) -> str:
    client = create_inference_client(provider="ollama", model="gemma2:27b", base_url=base_url, api_key=None)
    answer = await client.generate_text("Name one river of France.", max_tokens=200, temperature=0.0)
    return answer.text
