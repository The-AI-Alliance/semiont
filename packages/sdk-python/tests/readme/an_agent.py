from semiont.bus import reply_channels_for
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.operations import JOB_CLAIM
from semiont.watched import reached


async def work(gateway: str, issuer: str, secret: str) -> None:
    service = ServiceToken(Credential(issuer=issuer, client_id="semiont-smelter", client_secret=secret))
    async with (
        AgentToken(gateway, provider="ollama", model="gemma2:27b", service=service) as agent,
        HttpTransport(gateway, token=agent.token, refresher=agent.refresh, channels=reply_channels_for(JOB_CLAIM)) as transport,
    ):
        print(await reached(transport.state, lambda state: state == "open"))  # its stream is open, as the agent
