"""Publish a concurrent-player snapshot of games from Roblox's public charts."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

# https://create.roblox.com/docs/production/publishing/experience-genres
GENRES = {
    'Action': ['Battlegrounds & Fighting', 'Music & Rhythm', 'Open World Action'],
    'Adventure': ['Exploration', 'Scavenger Hunt', 'Story'],
    'Education': [],
    'Entertainment': ['Music & Audio', 'Showcase & Hub', 'Video'],
    'Obby & Platformer': ['Classic Obby', 'Runner', 'Tower Obby'],
    'Party & Casual': ['Childhood Game', 'Coloring & Drawing', 'Minigame', 'Quiz'],
    'Puzzle': ['Escape Room', 'Match & Merge', 'Word'],
    'Roleplay & Avatar Sim': ['Animal Sim', 'Dress Up', 'Life', 'Morph Roleplay', 'Pet Care'],
    'RPG': ['Action RPG', 'Open World & Survival RPG', 'Turn-based RPG'],
    'Shooter': ['Battle Royale', 'Deathmatch Shooter', 'PvE Shooter'],
    'Shopping': ['Avatar Shopping'],
    'Simulation': ['Idle', 'Incremental Simulator', 'Physics Sim', 'Sandbox', 'Tycoon', 'Vehicle Sim'],
    'Social': [],
    'Sports & Racing': ['Racing', 'Sports'],
    'Strategy': ['Board & Card Games', 'Tower Defense'],
    'Survival': ['1 vs All', 'Escape'],
    'Utility & Other': [],
}


def request_json(url, params, *, optional=False):
    request = Request(f'{url}?{urlencode(params)}', headers={'User-Agent': 'RoLibraryCharts/1.0'})
    for attempt in range(4):
        try:
            with urlopen(request, timeout=25) as response:
                data = json.load(response)
                remaining = response.headers.get('X-RateLimit-Remaining', '')
                reset = response.headers.get('X-RateLimit-Reset', '')
            if remaining == '0' and reset.isdecimal():
                time.sleep(min(int(reset) + 1, 61))
            return data
        except HTTPError as error:
            if optional and error.code == 404:
                return {}
            if attempt == 3 or (error.code != 429 and error.code < 500):
                raise
            delay = error.headers.get('Retry-After') or error.headers.get('X-RateLimit-Reset', '')
            fallback = 60 if error.code == 429 else 5 * (attempt + 1)
            time.sleep(min(int(delay) + 1, 61) if delay.isdecimal() else fallback)
        except (URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def make_charts(games):
    charts = {genre: {'games': [], 'subgenres': {name: [] for name in subgenres}}
              for genre, subgenres in GENRES.items()}
    genres = {genre.casefold(): genre for genre in GENRES}
    ranked = sorted((game for game in games if isinstance(game.get('playing'), int)
                     and game['playing'] >= 0 and game.get('rootPlaceId') and game.get('name')),
                    key=lambda game: (-game['playing'], game['id']))
    for game in ranked:
        genre = game.get('genre_l1')
        if not genre or genre.casefold() == 'unknown':
            continue
        genre = genres.get(genre.casefold(), genre)
        chart = charts.setdefault(genre, {'games': [], 'subgenres': {}})
        subgenre = game.get('genre_l2')
        entry = {'name': game['name'], 'place': game['rootPlaceId'], 'players': game['playing']}
        if len(chart['games']) < 100:
            chart['games'].append(entry)
        if subgenre and subgenre.casefold() != 'unknown':
            subgenre = next((name for name in chart['subgenres'] if name.casefold() == subgenre.casefold()), subgenre)
            subchart = chart['subgenres'].setdefault(subgenre, [])
            if len(subchart) < 100:
                subchart.append(entry)
    return charts


def publish_charts(output):
    ids = set()
    params = {'sessionId': str(uuid4()), 'device': 'computer', 'country': 'all'}
    explore = 'https://apis.roblox.com/explore-api/v1/'
    sorts = request_json(explore + 'get-sorts', params)['sorts']
    sort_ids = {sort['sortId'] for sort in sorts if sort.get('games') and sort.get('sortId')}
    sort_ids.add('top-playing-now')
    sort_ids.update('trending-in-' + genre.lower().replace(' & ', ' and ').replace(' ', '-') for genre in GENRES)
    for sort in sorts:
        ids.update(game['universeId'] for game in (sort.get('games') or []) if game.get('universeId'))
    for sort_id in sorted(sort_ids):
        content = request_json(explore + 'get-sort-content', {**params, 'sortId': sort_id},
                               optional=sort_id.startswith('trending-in-'))
        ids.update(game['universeId'] for game in (content.get('games') or []) if game.get('universeId'))

    games = {}
    ids = sorted(ids)
    print(f'Checking concurrent player counts for {len(ids):,} experiences.', flush=True)
    for offset in range(0, len(ids), 50):
        batch = ids[offset:offset + 50]
        response = request_json('https://games.roblox.com/v1/games', {'universeIds': ','.join(map(str, batch))})
        games.update((game['id'], game) for game in response['data'])
        time.sleep(.5)
    charts = make_charts(games.values())
    if not any(chart['games'] for chart in charts.values()):
        raise RuntimeError('Roblox returned no ranked games.')
    snapshot = {'updated': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'genres': charts}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Published charts from {len(games):,} Roblox experiences.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    publish_charts(args.output)
