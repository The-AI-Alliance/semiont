from pathlib import Path

from semiont.http import DeviceCode, session_from_kept, sign_in_device
from semiont.sign_in_store import FILE_NAME, SignInStore, state_dir, this_system


def show(code: DeviceCode) -> None:
    print(f"Open {code.verification_uri} and enter {code.user_code}")


async def as_me(gateway: str, home: str) -> None:
    directory = state_dir(this_system(), home=home, xdg_state_home=None, local_app_data=None)
    if directory is None:
        return
    kept = SignInStore(Path(directory) / FILE_NAME).entry("local")
    if await kept.held() is None:
        await sign_in_device(gateway, kept, show)
    async with session_from_kept(gateway, kb_id="local", kept=kept) as session:
        print(session.user.value, (await session.client.system.status()).version)
