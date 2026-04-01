import { useState, useCallback, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { mapsApi } from '../api/client'
import type { TripStoreState } from '../store/tripStore'
import type { RouteSegment, RouteResult, StopTiming } from '../types'

function addMinutesToTime(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number)
  const totalMin = h * 60 + m + minutes
  const newH = Math.floor(totalMin / 60) % 24
  const newM = totalMin % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

/**
 * Manages route calculation state for a selected day. Extracts geo-coded waypoints from
 * day assignments, draws a straight-line route, and optionally fetches per-segment
 * driving/walking durations via OSRM. Computes a timing schedule (arrival/departure times)
 * based on first stop departure time and duration at each stop.
 */
export function useRouteCalculation(tripStore: TripStoreState, selectedDayId: number | null) {
  const [route, setRoute] = useState<[number, number][] | null>(null)
  const [routeInfo, setRouteInfo] = useState<RouteResult | null>(null)
  const [routeSegments, setRouteSegments] = useState<RouteSegment[]>([])
  const [stopTimings, setStopTimings] = useState<StopTiming[]>([])
  const routeCalcEnabled = useSettingsStore((s) => s.settings.route_calculation) !== false
  const routeAbortRef = useRef<AbortController | null>(null)

  const computeTimings = useCallback((
    assignments: Array<{ id: number; place: { lat?: number | null; lng?: number | null; place_time?: string | null; end_time?: string | null; duration_minutes?: number | null }; duration_minutes?: number | null }>,
    segments: RouteSegment[]
  ): StopTiming[] => {
    if (assignments.length === 0) return []

    const timings: StopTiming[] = []
    const geoAssignments = assignments.filter(a => a.place?.lat && a.place?.lng)

    // First stop: departure time comes from assignment's place_time
    const firstDeparture = geoAssignments[0]?.place?.place_time || null

    let currentTime = firstDeparture // HH:MM or null

    for (let i = 0; i < geoAssignments.length; i++) {
      const a = geoAssignments[i]
      const isLast = i === geoAssignments.length - 1
      const durationMin = a.duration_minutes ?? a.place?.duration_minutes ?? 60
      const seg = i > 0 ? segments[i - 1] : null
      const endTime = a.place?.end_time || null

      let arrivalTime: string | null = null
      let departureTime: string | null = null
      let lateArrival = false
      let eventStartTime: string | null = null

      if (i === 0) {
        // First stop: departure = user-set time or end_time if event
        departureTime = endTime || currentTime
        if (endTime && a.place?.place_time) {
          eventStartTime = a.place.place_time
        }
      } else {
        // Subsequent stops: arrival = previous departure + driving time
        if (currentTime && seg) {
          const drivingMin = Math.ceil(seg.duration / 60)
          arrivalTime = addMinutesToTime(currentTime, drivingMin)

          // Check for late arrival: if place has a start time and we arrive after it
          const placeStartTime = a.place?.place_time || null
          if (placeStartTime && arrivalTime) {
            eventStartTime = placeStartTime
            if (timeToMinutes(arrivalTime) > timeToMinutes(placeStartTime)) {
              lateArrival = true
            }
          }

          if (!isLast) {
            if (endTime) {
              // Event with end time: departure = end_time (ignore duration)
              departureTime = endTime
            } else {
              departureTime = addMinutesToTime(arrivalTime, durationMin)
            }
          }
        }
      }

      currentTime = departureTime

      timings.push({
        assignmentId: a.id,
        arrivalTime,
        departureTime,
        durationMinutes: isLast ? 0 : durationMin,
        drivingFromPrev: seg ? seg.duration : null,
        distanceFromPrev: seg ? seg.distance : null,
        drivingText: seg ? seg.drivingText : null,
        distanceText: seg ? seg.distanceText : null,
        lateArrival,
        eventStartTime,
        eventEndTime: endTime,
      })
    }

    return timings
  }, [])

  const updateRouteForDay = useCallback(async (dayId: number | null) => {
    if (routeAbortRef.current) routeAbortRef.current.abort()
    if (!dayId) { setRoute(null); setRouteSegments([]); setStopTimings([]); return }
    const da = (tripStore.assignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    const waypoints = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
    if (waypoints.length < 2) {
      setRoute(null); setRouteSegments([])
      // Still compute timings for single stop
      setStopTimings(computeTimings(da, []))
      return
    }
    // Set straight-line fallback immediately while we fetch the real route
    setRoute(waypoints.map((p) => [p.lat!, p.lng!]))
    if (!routeCalcEnabled) {
      setRouteSegments([])
      setStopTimings(computeTimings(da, []))
      return
    }
    const controller = new AbortController()
    routeAbortRef.current = controller
    try {
      const result = await mapsApi.directions(
        waypoints.map(p => ({ lat: p.lat!, lng: p.lng! })),
        'driving'
      )
      if (controller.signal.aborted) return
      // Use road-following coordinates from the server
      if (result.coordinates?.length >= 2) {
        setRoute(result.coordinates)
      }
      // Map server segments to RouteSegment type
      const segments: RouteSegment[] = (result.segments || []).map((seg: any) => {
        const walkingDuration = seg.distance / (5000 / 3600)
        return {
          mid: seg.mid,
          from: seg.from,
          to: seg.to,
          distance: seg.distance,
          duration: seg.duration,
          distanceText: seg.distanceText,
          durationText: seg.durationText,
          walkingText: formatDuration(walkingDuration),
          drivingText: seg.durationText,
        }
      })
      setRouteSegments(segments)
      setStopTimings(computeTimings(da, segments))
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      setRouteSegments([])
      setStopTimings(computeTimings(da, []))
    }
  }, [tripStore, routeCalcEnabled, computeTimings])

  useEffect(() => {
    if (!selectedDayId) { setRoute(null); setRouteSegments([]); setStopTimings([]); return }
    updateRouteForDay(selectedDayId)
  }, [selectedDayId, tripStore.assignments])

  return { route, routeSegments, routeInfo, stopTimings, setRoute, setRouteInfo, updateRouteForDay }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}
