"""Contenedor Python-Dash: visualiza los asteroides guardados en MySQL."""
import json
import logging
import math
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import mysql.connector
import pandas as pd
import plotly.graph_objects as go
from dash import Dash, Input, Output, dash_table, dcc, html, no_update

INGESTOR_URL = os.environ.get("INGESTOR_URL", "http://ingestor:8000")

# Paleta (modo oscuro): dos categorías + tintas neutras.
COLOR_SEGURO = "#3987e5"
COLOR_PELIGROSO = "#d95926"
SUPERFICIE = "#1a1a19"
TINTA = "#f0efec"
TINTA_2 = "#c3c2b7"
TINTA_TENUE = "#898781"
REJILLA = "#2c2c2a"
EJE = "#383835"
FUENTE = 'system-ui, -apple-system, "Segoe UI", sans-serif'

app = Dash(__name__, meta_tags=[{"name": "viewport",
                                 "content": "width=device-width, initial-scale=1"}])
app.title = "Monitor de asteroides"
server = app.server


# --------------------------------------------------------------------------- Datos

def consultar(sql):
    conexion = mysql.connector.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        connection_timeout=5,
    )
    try:
        with conexion.cursor(dictionary=True) as cursor:
            cursor.execute(sql)
            return pd.DataFrame(cursor.fetchall())
    finally:
        conexion.close()


def leer_acercamientos():
    datos = consultar("""
        SELECT id_neo, nombre, fecha_acercamiento, velocidad_km_s, distancia_km,
               distancia_lunar, diametro_medio_m, es_peligroso, url_jpl
        FROM vista_acercamientos ORDER BY fecha_acercamiento
    """)
    if datos.empty:
        return datos
    # "(2020 QG3)" -> "2020 QG3"; los nombres numerados como "679786 (2020 QG3)" se conservan.
    entre_parentesis = datos["nombre"].str.match(r"^\(.*\)$")
    datos.loc[entre_parentesis, "nombre"] = datos.loc[entre_parentesis, "nombre"].str[1:-1]
    datos["es_peligroso"] = datos["es_peligroso"].astype(bool)
    datos["fecha_acercamiento"] = pd.to_datetime(datos["fecha_acercamiento"])
    # NeoWs a veces publica el mismo asteroide con dos ids (numerado y provisional): mismo
    # instante y misma distancia. Se conserva el registro numerado (nombre más largo).
    datos["_distancia"] = datos["distancia_lunar"].round(2)
    datos = (datos.sort_values("nombre", key=lambda s: s.str.len(), ascending=False)
                  .drop_duplicates(["fecha_acercamiento", "_distancia"])
                  .drop(columns="_distancia")
                  .sort_values("fecha_acercamiento", ignore_index=True))
    return datos


def filtrar(datos, periodo, solo_peligrosos):
    if datos.empty:
        return datos
    ahora = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None))
    fecha = datos["fecha_acercamiento"]
    if periodo == "pasado":
        datos = datos[(fecha < ahora) & (fecha >= ahora - timedelta(days=7))]
    elif periodo == "futuro":
        datos = datos[(fecha >= ahora) & (fecha <= ahora + timedelta(days=7))]
    if solo_peligrosos:
        datos = datos[datos["es_peligroso"]]
    return datos


# --------------------------------------------------------------------------- Gráficas

def estilo_base(fig, titulo_x, titulo_y, leyenda):
    fig.update_layout(
        paper_bgcolor=SUPERFICIE, plot_bgcolor=SUPERFICIE, height=380,
        font=dict(family=FUENTE, color=TINTA_2, size=13),
        margin=dict(l=64, r=20, t=44, b=52), showlegend=leyenda,
        legend=dict(orientation="h", x=0, y=1.04, yanchor="bottom", title_text="",
                    font=dict(color=TINTA_2)),
        hoverlabel=dict(bgcolor="#262624", bordercolor=EJE, font=dict(color=TINTA, family=FUENTE)),
    )
    ejes = dict(gridcolor=REJILLA, linecolor=EJE, zeroline=False, tickfont=dict(color=TINTA_TENUE),
                title_font=dict(color=TINTA_2))
    fig.update_xaxes(title_text=titulo_x, **ejes)
    fig.update_yaxes(title_text=titulo_y, **ejes)
    return fig


def figura_vacia(mensaje):
    fig = go.Figure()
    fig.add_annotation(text=mensaje, showarrow=False, font=dict(color=TINTA_2, size=14),
                       xref="paper", yref="paper", x=0.5, y=0.5)
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    fig.update_layout(paper_bgcolor=SUPERFICIE, plot_bgcolor=SUPERFICIE, height=380,
                      margin=dict(l=20, r=20, t=20, b=20))
    return fig


def series(datos):
    """Divide en (etiqueta, color, subconjunto) manteniendo siempre el mismo color por categoría."""
    return [(etiqueta, color, datos[datos["es_peligroso"] == valor])
            for etiqueta, color, valor in [("No peligroso", COLOR_SEGURO, False),
                                           ("Potencialmente peligroso", COLOR_PELIGROSO, True)]
            if (datos["es_peligroso"] == valor).any()]


def figura_por_dia(datos):
    fig = go.Figure()
    grupos = series(datos)
    for etiqueta, color, subconjunto in grupos:
        conteo = subconjunto.groupby(subconjunto["fecha_acercamiento"].dt.normalize()).size()
        fig.add_bar(
            x=conteo.index + pd.Timedelta(hours=12), y=conteo.values, name=etiqueta,
            marker=dict(color=color, line=dict(color=SUPERFICIE, width=2)),
            hovertemplate=f"%{{x|%d/%m/%Y}}<br>{etiqueta}: %{{y}}<extra></extra>",
        )
    ahora = datetime.now(timezone.utc).replace(tzinfo=None)
    fig.add_shape(type="line", x0=ahora, x1=ahora, y0=0, y1=1, yref="paper",
                  line=dict(color=TINTA_TENUE, width=1))
    fig.add_annotation(x=ahora, y=1, yref="paper", text="ahora", showarrow=False,
                       xanchor="left", yanchor="top", xshift=4, font=dict(color=TINTA_2, size=12))
    fig.update_layout(barmode="stack", bargap=0.35, barcornerradius=4)
    fig.update_xaxes(tickformat="%d/%m", dtick=86_400_000 * 2)
    return estilo_base(fig, "Fecha de máxima aproximación (UTC)", "Acercamientos", len(grupos) > 1)


def figura_dispersion(datos):
    fig = go.Figure()
    grupos = series(datos)
    for etiqueta, color, subconjunto in grupos:
        fig.add_scatter(
            x=subconjunto["distancia_lunar"], y=subconjunto["diametro_medio_m"], mode="markers",
            name=etiqueta,
            marker=dict(color=color, size=10, line=dict(color=SUPERFICIE, width=2)),
            customdata=list(zip(subconjunto["nombre"],
                                subconjunto["fecha_acercamiento"].dt.strftime("%d/%m/%Y %H:%M"),
                                subconjunto["velocidad_km_s"], subconjunto["distancia_km"])),
            hovertemplate=("<b>%{customdata[0]}</b><br>%{customdata[1]} UTC<br>"
                           "Distancia: %{x:.1f} DL (%{customdata[3]:,.0f} km)<br>"
                           "Diámetro medio: %{y:,.0f} m<br>"
                           "Velocidad: %{customdata[2]:.1f} km/s<extra></extra>"),
        )
    # Línea de referencia en 1 DL (como traza para que use unidades de datos en el eje log).
    diametros = datos["diametro_medio_m"]
    fig.add_scatter(x=[1, 1], y=[diametros.min() / 1.5, diametros.max() * 1.5], mode="lines",
                    line=dict(color=TINTA_TENUE, width=1), hoverinfo="skip", showlegend=False)
    # En ejes log, las anotaciones se posicionan con log10(valor): 0 = 1 DL.
    fig.add_annotation(x=0, xref="x", y=1, yref="paper", text="Órbita de la Luna",
                       showarrow=False, xanchor="left", yanchor="top", xshift=4,
                       font=dict(color=TINTA_2, size=12))
    distancias = datos["distancia_lunar"]
    fig.update_xaxes(type="log", range=[math.log10(min(0.5, distancias.min() / 1.5)),
                                        math.log10(max(2, distancias.max() * 1.5))])
    fig.update_yaxes(type="log")
    return estilo_base(fig, "Distancia mínima (distancias lunares, escala log)",
                       "Diámetro medio estimado (m, escala log)", len(grupos) > 1)


# --------------------------------------------------------------------------- Componentes

def tarjeta(etiqueta, valor, detalle=""):
    return html.Div([html.Span(etiqueta, className="kpi-etiqueta"),
                     html.Span(valor, className="kpi-valor"),
                     html.Span(detalle, className="kpi-detalle")], className="kpi")


def tarjetas(datos):
    if datos.empty:
        return [tarjeta(t, "—") for t in ["Asteroides", "Acercamientos",
                                          "Potencialmente peligrosos", "Paso más cercano",
                                          "Mayor velocidad"]]
    cercano = datos.loc[datos["distancia_lunar"].idxmin()]
    rapido = datos.loc[datos["velocidad_km_s"].idxmax()]
    unicos = datos["id_neo"].nunique()
    peligrosos = datos.loc[datos["es_peligroso"], "id_neo"].nunique()
    return [
        tarjeta("Asteroides", f"{unicos:,}", "objetos distintos"),
        tarjeta("Acercamientos", f"{len(datos):,}", "pasos registrados"),
        tarjeta("Potencialmente peligrosos", f"{peligrosos:,}",
                f"{peligrosos / unicos:.0%} de los asteroides"),
        tarjeta("Paso más cercano", f"{cercano['distancia_lunar']:.2f} DL",
                f"{cercano['nombre']} · {cercano['fecha_acercamiento']:%d/%m %H:%M} UTC"),
        tarjeta("Mayor velocidad", f"{rapido['velocidad_km_s']:.1f} km/s",
                f"{rapido['nombre']} · {rapido['velocidad_km_s'] * 3600:,.0f} km/h"),
    ]


def cuenta_atras(delta):
    horas = int(delta.total_seconds() // 3600)
    if horas < 1:
        return f"en {int(delta.total_seconds() // 60)} min"
    if horas < 48:
        return f"en {horas} h"
    return f"en {horas // 24} días"


def seccion_proximo(todos):
    """Destaca el siguiente asteroide en alcanzar su punto más cercano (sin aplicar filtros)."""
    if todos.empty:
        return html.Div("Aún no hay datos. Pulsa «Sincronizar con la NASA» para consultar la API.",
                        className="proximo-vacio")
    ahora = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None))
    futuros = todos[todos["fecha_acercamiento"] >= ahora]
    if futuros.empty:
        return html.Div("No hay acercamientos futuros guardados; sincroniza para actualizar.",
                        className="proximo-vacio")
    neo = futuros.iloc[0]
    distancia_luna = (f"{neo['distancia_lunar']:.1f} veces la distancia a la Luna"
                      if neo["distancia_lunar"] >= 1 else
                      f"más cerca que la Luna ({neo['distancia_lunar']:.2f} DL)")
    datos = [("Distancia mínima", f"{neo['distancia_km']:,.0f} km"),
             ("Diámetro estimado", f"{neo['diametro_medio_m']:,.0f} m"),
             ("Velocidad relativa", f"{neo['velocidad_km_s']:.1f} km/s"),
             ("Clasificación", "Potencialmente peligroso" if neo["es_peligroso"] else "No peligroso")]
    return [
        html.Div([
            html.Span("Próximo paso cercano", className="proximo-etiqueta"),
            html.H2(html.A(neo["nombre"], href=neo["url_jpl"], target="_blank")
                    if neo["url_jpl"] else neo["nombre"]),
            html.P(f"{cuenta_atras(neo['fecha_acercamiento'] - ahora)} · "
                   f"{neo['fecha_acercamiento']:%d/%m/%Y %H:%M} UTC · {distancia_luna}"),
        ], className="proximo-titulo"),
        html.Dl([elemento for etiqueta, valor in datos
                 for elemento in (html.Dt(etiqueta), html.Dd(valor))], className="proximo-datos"),
    ]


def tabla_cercanos(datos):
    top = datos.nsmallest(10, "distancia_lunar")
    return [{
        "nombre": f"[{fila.nombre}]({fila.url_jpl})" if fila.url_jpl else fila.nombre,
        "fecha": f"{fila.fecha_acercamiento:%Y-%m-%d %H:%M}",
        "distancia_lunar": round(fila.distancia_lunar, 2),
        "distancia_km": round(fila.distancia_km),
        "diametro": round(fila.diametro_medio_m),
        "velocidad": round(fila.velocidad_km_s, 1),
        "peligroso": "Sí" if fila.es_peligroso else "No",
    } for fila in top.itertuples()]


def tabla_ingestas():
    datos = consultar("SELECT * FROM ingestas ORDER BY id DESC LIMIT 8")
    return [{
        "inicio": f"{fila.inicio_ejecucion:%Y-%m-%d %H:%M:%S}",
        "fuente": fila.fuente,
        "origen": fila.origen,
        "rango": f"{fila.rango_inicio} → {fila.rango_fin}" if fila.rango_inicio else "—",
        "registros": fila.registros,
        "nuevos": fila.nuevos,
        "estado": "OK" if fila.estado == "ok" else "Error",
        "duracion": f"{fila.duracion_s:.1f} s",
        "mensaje": fila.mensaje,
    } for fila in datos.itertuples()]


ESTILO_TABLA = dict(
    style_as_list_view=True,
    style_table={"overflowX": "auto"},
    style_header={"backgroundColor": SUPERFICIE, "color": TINTA_TENUE, "fontWeight": "600",
                  "borderBottom": f"1px solid {EJE}", "fontFamily": FUENTE},
    style_cell={"backgroundColor": SUPERFICIE, "color": TINTA, "border": "none",
                "borderBottom": f"1px solid {REJILLA}", "fontFamily": FUENTE,
                "fontSize": "14px", "padding": "10px 12px", "textAlign": "left",
                "fontVariantNumeric": "tabular-nums", "whiteSpace": "normal", "height": "auto"},
    markdown_options={"link_target": "_blank"},
)

COLUMNAS_CERCANOS = [
    {"name": "Asteroide", "id": "nombre", "presentation": "markdown"},
    {"name": "Fecha (UTC)", "id": "fecha"},
    {"name": "Distancia (DL)", "id": "distancia_lunar", "type": "numeric"},
    {"name": "Distancia (km)", "id": "distancia_km", "type": "numeric",
     "format": {"specifier": ",.0f"}},
    {"name": "Diámetro medio (m)", "id": "diametro", "type": "numeric",
     "format": {"specifier": ",.0f"}},
    {"name": "Velocidad (km/s)", "id": "velocidad", "type": "numeric"},
    {"name": "Potencialmente peligroso", "id": "peligroso"},
]

COLUMNAS_INGESTAS = [
    {"name": "Inicio (UTC)", "id": "inicio"}, {"name": "Fuente", "id": "fuente"},
    {"name": "Origen", "id": "origen"}, {"name": "Rango consultado", "id": "rango"},
    {"name": "Registros", "id": "registros"}, {"name": "Nuevos", "id": "nuevos"},
    {"name": "Estado", "id": "estado"}, {"name": "Duración", "id": "duracion"},
    {"name": "Mensaje", "id": "mensaje"},
]


def panel(titulo, descripcion, contenido):
    return html.Section([html.H2(titulo), html.P(descripcion, className="panel-descripcion"),
                         contenido], className="panel")


app.layout = html.Div([
    html.Header([
        html.Div([
            html.H1("Monitor de asteroides cercanos a la Tierra"),
            html.P("API NeoWs de la NASA → contenedor Ubuntu → MySQL → Dash · horas en UTC"),
        ]),
        html.Div([
            html.Button("Sincronizar con la NASA", id="sincronizar", className="boton"),
            dcc.Loading(html.Span(id="mensaje-sync", className="mensaje-sync"),
                        type="dot", color=COLOR_SEGURO),
        ], className="acciones"),
    ], className="cabecera"),
    html.Section(id="proximo", className="proximo"),
    html.Div([
        dcc.RadioItems(id="periodo", inline=True, value="todo", className="segmentado",
                       options=[{"label": "Todo lo guardado", "value": "todo"},
                                {"label": "Últimos 7 días", "value": "pasado"},
                                {"label": "Próximos 7 días", "value": "futuro"}]),
        dcc.Checklist(id="solo-peligrosos", value=[], className="casilla",
                      options=[{"label": " Solo potencialmente peligrosos", "value": "si"}]),
    ], className="filtros"),
    html.Div(id="kpis", className="kpis"),
    html.Div([
        panel("Acercamientos por día",
              "Número de asteroides que alcanzan su punto más cercano a la Tierra cada día.",
              dcc.Graph(id="por-dia", config={"displayModeBar": False})),
        panel("Distancia frente a tamaño",
              "Cada punto es un paso cercano. A la izquierda de la línea, más cerca que la Luna.",
              dcc.Graph(id="dispersion", config={"displayModeBar": False})),
    ], className="rejilla"),
    panel("Los 10 pasos más cercanos",
          "1 DL (distancia lunar) = 384,400 km. El nombre enlaza a la ficha del JPL de la NASA.",
          dash_table.DataTable(id="tabla-cercanos", columns=COLUMNAS_CERCANOS, **ESTILO_TABLA)),
    panel("Bitácora de ingestas",
          "Cada ejecución del contenedor ingestor: automática cada 6 horas o manual con el botón.",
          dash_table.DataTable(id="tabla-ingestas", columns=COLUMNAS_INGESTAS, **ESTILO_TABLA)),
    html.P(id="estado", className="estado"),
    dcc.Interval(id="reloj", interval=30_000),
    dcc.Store(id="ultima-sync"),
], className="pagina")


# --------------------------------------------------------------------------- Callbacks

@app.callback(
    Output("kpis", "children"), Output("por-dia", "figure"), Output("dispersion", "figure"),
    Output("tabla-cercanos", "data"), Output("tabla-ingestas", "data"),
    Output("proximo", "children"), Output("estado", "children"),
    Input("periodo", "value"), Input("solo-peligrosos", "value"),
    Input("reloj", "n_intervals"), Input("ultima-sync", "data"),
)
def actualizar(periodo, solo_peligrosos, _intervalo, _sync):
    try:
        todos = leer_acercamientos()
        ingestas = tabla_ingestas()
    except mysql.connector.Error:
        logging.exception("No se pudo consultar MySQL")
        vacia = figura_vacia("No se pudo consultar MySQL. Se reintentará automáticamente.")
        return (tarjetas(pd.DataFrame()), vacia, vacia, [], [], no_update,
                "Conexión con MySQL no disponible; revisa docker compose logs mysql.")
    datos = filtrar(todos, periodo, bool(solo_peligrosos))
    if datos.empty:
        mensaje = ("Sin datos todavía: pulsa «Sincronizar con la NASA»." if todos.empty
                   else "Ningún acercamiento coincide con el filtro.")
        vacia = figura_vacia(mensaje)
        return tarjetas(datos), vacia, vacia, [], ingestas, seccion_proximo(todos), mensaje
    estado = (f"Última consulta a MySQL: {datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S} UTC · "
              f"{len(datos):,} de {len(todos):,} acercamientos mostrados · se actualiza cada 30 s.")
    return (tarjetas(datos), figura_por_dia(datos), figura_dispersion(datos),
            tabla_cercanos(datos), ingestas, seccion_proximo(todos), estado)


@app.callback(
    Output("mensaje-sync", "children"), Output("ultima-sync", "data"),
    Input("sincronizar", "n_clicks"), prevent_initial_call=True,
    running=[(Output("sincronizar", "disabled"), True, False)],
)
def sincronizar(_clicks):
    peticion = urllib.request.Request(f"{INGESTOR_URL}/sincronizar", data=b"", method="POST")
    try:
        with urllib.request.urlopen(peticion, timeout=150) as respuesta:
            cuerpo = json.load(respuesta)
    except urllib.error.HTTPError as error:
        try:
            cuerpo = json.load(error)
        except ValueError:
            return f"El ingestor respondió HTTP {error.code}.", no_update
    except (urllib.error.URLError, TimeoutError) as error:
        return f"No se pudo contactar al ingestor: {error}", no_update
    if cuerpo.get("estado") == "ocupado":
        return cuerpo["mensaje"], no_update
    partes = [f"{r['fuente']}: {r['registros']} recibidos, {r['nuevos']} nuevos"
              if r["estado"] == "ok" else f"{r['fuente']}: error — {r['mensaje']}"
              for r in cuerpo.get("resultados", [])]
    return " · ".join(partes), datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8050, debug=False)
