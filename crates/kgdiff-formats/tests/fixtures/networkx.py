# Writes the networkx-* fixtures: one graph each, as GraphML and as node-link JSON.
#
#   uv run --with networkx python crates/kgdiff-formats/tests/fixtures/networkx.py
#
# tests/graphml.rs checks that kgdiff reads the two files of a pair as the same graph.
import json
import pathlib

import networkx as nx

here = pathlib.Path(__file__).parent


def write(name, graph):
    nx.write_graphml(graph, here / f"{name}.graphml")
    data = nx.node_link_data(graph, edges="links")
    with open(here / f"{name}.json", "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=1)
        file.write("\n")


# Undirected, with a field of every type and graph attributes.
g = nx.Graph(name="chibi", version="1")
g.add_node("曹操", label="曹操", type="人物", born=155, famous=True, weight=0.75)
g.add_node("刘备", label="刘备", type="人物", born=161, famous=True)
g.add_node("孙权", label="孙权", type="人物", born=182, famous=False)
g.add_node("赤壁", label="赤壁之战", type="事件", year=208, description="孙刘联军 & 曹军 <长江>")
g.add_edge("曹操", "赤壁", relation="参战", weight=1.0)
g.add_edge("刘备", "赤壁", relation="参战", weight=0.5)
g.add_edge("刘备", "孙权", relation="结盟", since=208)
g.add_edge("孙权", "赤壁", relation="参战", weight=0.5)
write("networkx-undirected", g)

# Directed, integer node ids, the fields LightRAG keeps.
d = nx.DiGraph()
d.add_node(1, entity_id="Ada", entity_type="person", description="Wrote the first program", source_id="chunk-1")
d.add_node(2, entity_id="Engine", entity_type="machine", description="Analytical Engine", source_id="chunk-1<SEP>chunk-2")
d.add_edge(1, 2, weight=2.0, description="designed programs for", keywords="program,design", source_id="chunk-1")
write("networkx-directed", d)
